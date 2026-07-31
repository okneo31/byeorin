// tcp_bridge.rs — BTC 이력 트랙 B: 원시 TCP/TLS 브리지.
//
// 웹뷰(JS)에는 원시 소켓이 없으므로, packages/wallet-sdk/src/btc-history/transport.ts
// 의 ByteTransport 계약을 데스크톱에서 만족시키기 위해 소켓을 Rust 쪽에 둔다.
//
// 표면:
//   커맨드  tcp_open(host, port, tls, timeout_ms) -> socket_id
//           tcp_write(socket_id, base64)
//           tcp_close(socket_id)
//   이벤트  "tcp-data"  { socketId, base64 }   — 수신 스트림 조각 그대로
//           "tcp-close" { socketId, error? }   — 원격/오류 종료 (tcp_close 경유는 제외)
//
// TLS 는 native-tls 를 택했다 (rustls 대신). 이유:
//   - native-tls 는 OS TLS 스택(Windows SChannel / macOS SecureTransport /
//     Linux OpenSSL)에 바인딩만 하므로 컴파일 산출물이 가볍다. rustls 는 ring
//     또는 aws-lc-rs 암호 구현 전체를 끌고 오고, Windows 에서는 NASM/cmake 류
//     추가 C 툴체인을 요구할 수 있다.
//   - OS 루트 인증서 저장소를 그대로 쓰므로 webpki-roots 번들이 불필요하다.
//
// 수신 처리: 태스크(스레드) 분리 요구는 소켓별 tokio 태스크로 충족한다 — tauri 2
// 는 이미 tokio 런타임 위에서 돌므로(OS 스레드를 새로 만들 필요 없음), 읽기/쓰기
// 반쪽을 tokio::io::split 으로 나눠 읽기 태스크가 blocking 없이 이벤트를 밀어낸다.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::timeout;

type BoxReader = Box<dyn AsyncRead + Send + Unpin>;
type BoxWriter = Box<dyn AsyncWrite + Send + Unpin>;

struct SocketEntry {
    /// Arc 로 감싸 테이블 잠금을 쓰기 동안 붙들지 않는다 (get→clone→drop→write).
    writer: Arc<Mutex<BoxWriter>>,
    /// 읽기 태스크 핸들 — tcp_close 시 abort 해서 "tcp-close" 이중 발신을 막는다.
    reader: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct TcpBridgeState {
    next_id: AtomicU32,
    sockets: Mutex<HashMap<u32, SocketEntry>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TcpDataEvent {
    socket_id: u32,
    base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TcpCloseEvent {
    socket_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// 연결 → socket_id 반환. `tls: true` 면 host 로 SNI/검증하는 TLS 핸드셰이크까지.
/// timeout_ms 미지정 시 8000ms (transport.ts 권장값).
#[tauri::command]
pub async fn tcp_open(
    app: AppHandle,
    state: State<'_, TcpBridgeState>,
    host: String,
    port: u16,
    tls: bool,
    timeout_ms: Option<u64>,
) -> Result<u32, String> {
    let dur = Duration::from_millis(timeout_ms.unwrap_or(8_000));

    let tcp = timeout(dur, TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| format!("tcp_open: {host}:{port} 연결 {}ms 초과", dur.as_millis()))?
        .map_err(|e| format!("tcp_open: {host}:{port} 연결 실패 — {e}"))?;
    // Electrum 류 요청/응답 왕복에는 Nagle 지연이 손해라 끈다.
    let _ = tcp.set_nodelay(true);

    let (reader, writer): (BoxReader, BoxWriter) = if tls {
        let connector = native_tls::TlsConnector::new()
            .map_err(|e| format!("tcp_open: TLS 초기화 실패 — {e}"))?;
        let connector = tokio_native_tls::TlsConnector::from(connector);
        let stream = timeout(dur, connector.connect(&host, tcp))
            .await
            .map_err(|_| format!("tcp_open: {host}:{port} TLS 핸드셰이크 {}ms 초과", dur.as_millis()))?
            .map_err(|e| format!("tcp_open: {host}:{port} TLS 실패 — {e}"))?;
        let (r, w) = tokio::io::split(stream);
        (Box::new(r), Box::new(w))
    } else {
        let (r, w) = tcp.into_split();
        (Box::new(r), Box::new(w))
    };

    let socket_id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;

    // 테이블 잠금을 쥔 채 spawn→insert: pump 가 즉시 종료해도 remove 가 insert
    // 뒤로 직렬화되어 유령 엔트리가 남지 않는다.
    let mut sockets = state.sockets.lock().await;
    let reader_task = tauri::async_runtime::spawn(pump(app.clone(), socket_id, reader));
    sockets.insert(
        socket_id,
        SocketEntry {
            writer: Arc::new(Mutex::new(writer)),
            reader: reader_task,
        },
    );
    drop(sockets);

    Ok(socket_id)
}

/// base64 페이로드를 디코드해 소켓에 쓴다. 닫힌/없는 소켓이면 오류.
#[tauri::command]
pub async fn tcp_write(
    state: State<'_, TcpBridgeState>,
    socket_id: u32,
    base64: String,
) -> Result<(), String> {
    let bytes = B64
        .decode(base64.as_bytes())
        .map_err(|e| format!("tcp_write: base64 해석 실패 — {e}"))?;

    let writer = {
        let sockets = state.sockets.lock().await;
        sockets
            .get(&socket_id)
            .ok_or_else(|| format!("tcp_write: 소켓 {socket_id} 없음(닫혔거나 미개설)"))?
            .writer
            .clone()
    };

    let mut w = writer.lock().await;
    w.write_all(&bytes)
        .await
        .map_err(|e| format!("tcp_write: 전송 실패 — {e}"))?;
    w.flush()
        .await
        .map_err(|e| format!("tcp_write: flush 실패 — {e}"))?;
    Ok(())
}

/// 소켓 종료. 이미 닫혔으면 no-op (JS 쪽 이중 호출 허용).
/// 이 경로로 닫으면 읽기 태스크를 abort 하므로 "tcp-close" 이벤트는 나가지 않는다
/// — 자발적 종료의 onClose 통지는 JS 래퍼(native-tcp.ts)가 직접 한다.
#[tauri::command]
pub async fn tcp_close(state: State<'_, TcpBridgeState>, socket_id: u32) -> Result<(), String> {
    let entry = state.sockets.lock().await.remove(&socket_id);
    if let Some(entry) = entry {
        entry.reader.abort();
        let mut w = entry.writer.lock().await;
        let _ = w.shutdown().await;
    }
    Ok(())
}

/// 소켓별 읽기 루프 — 조각을 그대로 base64 로 "tcp-data" 에 싣는다.
/// EOF(0)·오류 시 테이블에서 자신을 제거하고 "tcp-close" 를 알린다.
async fn pump(app: AppHandle, socket_id: u32, mut reader: BoxReader) {
    let mut buf = vec![0u8; 16 * 1024];
    let error = loop {
        match reader.read(&mut buf).await {
            Ok(0) => break None, // 원격이 정상 종료
            Ok(n) => {
                let _ = app.emit(
                    "tcp-data",
                    TcpDataEvent {
                        socket_id,
                        base64: B64.encode(&buf[..n]),
                    },
                );
            }
            Err(e) => break Some(e.to_string()),
        }
    };

    if let Some(state) = app.try_state::<TcpBridgeState>() {
        state.sockets.lock().await.remove(&socket_id);
    }
    let _ = app.emit("tcp-close", TcpCloseEvent { socket_id, error });
}
