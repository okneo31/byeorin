package top.ttl1.byeorin;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * TcpSocket — WebView 가 열 수 없는 원시 TCP 소켓을 네이티브 계층이 대신 연다.
 *
 * 왜 필요한가.
 *   BTC 이력(Electrum 프로토콜)은 JSON 줄바꿈 스트림을 TCP/TLS(50001/50002)로
 *   주고받는다. WebView 의 네트워크 표면은 fetch/WebSocket 뿐이라 원시 TCP 가
 *   없다 — 확장의 릴레이(D 경로)와 달리 안드로이드는 네이티브 소켓을 직접
 *   열 수 있으므로 중간 서버 없이 붙는다.
 *
 * 표면 (JS 쪽 계약은 apps/android/src/native-tcp.ts):
 *   open(host, port, tls?, timeoutMs?) → { socketId }
 *   write(socketId, base64)            — FIFO 보장 (소켓당 단일 쓰기 스레드)
 *   close(socketId)                    — 멱등
 *   이벤트: 'data'  { socketId, base64 }          수신 조각 그대로
 *           'close' { socketId, error? }          error 있으면 비정상 종료
 *
 * 스레드 규칙: 모든 블로킹 I/O 는 소켓별 스레드(읽기 1 + 쓰기 1)와 연결용
 * 풀에서만 한다. UI 스레드는 절대 건드리지 않는다 (연결 8초 대기가 ANR 이 된다).
 *
 * TLS: 플랫폼 기본 SSLSocketFactory — 인증서 체인은 시스템 TrustManager 가
 * 검사한다. 기본 SSLSocket 은 호스트명 대조를 생략하므로(HTTPS 클라이언트와
 * 다른 지점) endpoint identification 을 명시적으로 켠다. 자가서명 Electrum
 * 서버는 여기서 거부된다 — 신뢰 완화는 별도 결정 없이 하지 않는다.
 */
@CapacitorPlugin(name = "TcpSocket")
public class TcpSocketPlugin extends Plugin {

    private static final int DEFAULT_TIMEOUT_MS = 8000;
    private static final int READ_BUFFER_BYTES = 16 * 1024;

    /** socketId 발급기. 프로세스 생존 동안 단조 증가 — 재사용으로 인한 오배달 방지. */
    private final AtomicInteger nextId = new AtomicInteger(1);

    private final Map<String, Entry> sockets = new ConcurrentHashMap<>();

    /** 연결 시도와 close 처럼 짧은 블로킹 작업용 공용 풀. */
    private final ExecutorService ioPool = Executors.newCachedThreadPool();

    private static final class Entry {
        final Socket socket;
        final OutputStream out;
        /** 소켓당 단일 쓰레드 — write 호출 순서 = 전송 순서 (FIFO). */
        final ExecutorService writer = Executors.newSingleThreadExecutor();
        /** true 면 close() 요청에 의한 종료 — 'close' 이벤트에 error 를 싣지 않는다. */
        volatile boolean closedByApp = false;

        Entry(Socket socket, OutputStream out) {
            this.socket = socket;
            this.out = out;
        }
    }

    // ── open ──────────────────────────────────────────────────────────────

    @PluginMethod
    public void open(PluginCall call) {
        String host = call.getString("host");
        Integer port = call.getInt("port");
        if (host == null || host.isEmpty() || port == null || port < 1 || port > 65535) {
            call.reject("host and port (1-65535) are required");
            return;
        }
        boolean tls = Boolean.TRUE.equals(call.getBoolean("tls", false));
        Integer timeoutBoxed = call.getInt("timeoutMs", DEFAULT_TIMEOUT_MS);
        int timeoutMs = timeoutBoxed == null ? DEFAULT_TIMEOUT_MS : timeoutBoxed;
        int portV = port;
        ioPool.execute(() -> doOpen(call, host, portV, tls, timeoutMs));
    }

    private void doOpen(PluginCall call, String host, int port, boolean tls, int timeoutMs) {
        Socket socket = null;
        try {
            socket = new Socket();
            socket.connect(new InetSocketAddress(host, port), timeoutMs);
            // Electrum 은 요청 한 줄 → 응답 한 줄이 잦다. Nagle 지연은 손해만 있다.
            socket.setTcpNoDelay(true);

            if (tls) {
                SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
                SSLSocket ssl = (SSLSocket) factory.createSocket(socket, host, port, true);
                SSLParameters params = ssl.getSSLParameters();
                params.setEndpointIdentificationAlgorithm("HTTPS");
                ssl.setSSLParameters(params);
                // 핸드셰이크가 응답 없는 서버에서 무한 대기하지 않도록 한시적 read 타임아웃.
                ssl.setSoTimeout(timeoutMs);
                ssl.startHandshake();
                ssl.setSoTimeout(0); // 이후 read 는 블로킹 대기 (읽기 스레드 소유)
                socket = ssl;
            }

            String socketId = String.valueOf(nextId.getAndIncrement());
            Entry entry = new Entry(socket, socket.getOutputStream());
            sockets.put(socketId, entry);

            Thread reader = new Thread(() -> readLoop(socketId, entry), "byeorin-tcp-read-" + socketId);
            reader.setDaemon(true);
            reader.start();

            JSObject ret = new JSObject();
            ret.put("socketId", socketId);
            call.resolve(ret);
        } catch (Exception e) {
            if (socket != null) {
                try { socket.close(); } catch (IOException ignored) { }
            }
            call.reject("connect failed: " + e.getMessage(), e);
        }
    }

    // ── 읽기 스레드 ────────────────────────────────────────────────────────

    private void readLoop(String socketId, Entry entry) {
        byte[] buf = new byte[READ_BUFFER_BYTES];
        String error = null;
        try {
            InputStream in = entry.socket.getInputStream();
            int n;
            while ((n = in.read(buf)) != -1) {
                JSObject ev = new JSObject();
                ev.put("socketId", socketId);
                ev.put("base64", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP));
                notifyListeners("data", ev);
            }
            // n == -1: 서버가 정상적으로 스트림을 닫음 — error 없이 'close'.
        } catch (IOException e) {
            // close() 가 소켓을 닫으면 read 가 SocketException 으로 풀린다.
            // 그건 오류가 아니라 우리가 시킨 종료다.
            if (!entry.closedByApp) {
                error = String.valueOf(e.getMessage());
            }
        } finally {
            sockets.remove(socketId);
            entry.writer.shutdown();
            try { entry.socket.close(); } catch (IOException ignored) { }
            JSObject ev = new JSObject();
            ev.put("socketId", socketId);
            if (error != null) {
                ev.put("error", error);
            }
            notifyListeners("close", ev);
        }
    }

    // ── write ─────────────────────────────────────────────────────────────

    @PluginMethod
    public void write(PluginCall call) {
        String socketId = call.getString("socketId");
        String base64 = call.getString("base64");
        if (socketId == null || base64 == null) {
            call.reject("socketId and base64 are required");
            return;
        }
        Entry entry = sockets.get(socketId);
        if (entry == null) {
            call.reject("no such socket: " + socketId);
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(base64, Base64.NO_WRAP);
        } catch (IllegalArgumentException e) {
            call.reject("invalid base64: " + e.getMessage());
            return;
        }
        try {
            entry.writer.execute(() -> {
                try {
                    entry.out.write(bytes);
                    entry.out.flush();
                    call.resolve();
                } catch (IOException e) {
                    call.reject("write failed: " + e.getMessage(), e);
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            // 읽기 스레드가 writer 를 이미 내렸다 = 소켓이 그 사이 닫혔다.
            call.reject("socket closed: " + socketId);
        }
    }

    // ── close ─────────────────────────────────────────────────────────────

    /** 멱등 — 이미 닫혔거나 모르는 socketId 면 그냥 성공으로 응답한다. */
    @PluginMethod
    public void close(PluginCall call) {
        String socketId = call.getString("socketId");
        Entry entry = socketId == null ? null : sockets.get(socketId);
        if (entry == null) {
            call.resolve();
            return;
        }
        entry.closedByApp = true;
        ioPool.execute(() -> {
            try { entry.socket.close(); } catch (IOException ignored) { }
            // 'close' 이벤트 발행은 읽기 스레드의 finally 가 담당한다 (단일 발행 지점).
            call.resolve();
        });
    }

    // ── 수명 ──────────────────────────────────────────────────────────────

    @Override
    protected void handleOnDestroy() {
        // 액티비티가 죽으면 열린 소켓을 전부 정리한다. 읽기 스레드는 daemon 이라
        // 프로세스 종료를 막지 않지만, 명시적으로 닫아 서버 쪽 리소스도 풀어준다.
        for (Entry entry : sockets.values()) {
            entry.closedByApp = true;
            try { entry.socket.close(); } catch (IOException ignored) { }
        }
        sockets.clear();
        ioPool.shutdown();
        super.handleOnDestroy();
    }
}
