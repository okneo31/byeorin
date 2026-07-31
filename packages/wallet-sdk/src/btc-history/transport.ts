// transport.ts — BTC 이력 트랙(B: Electrum · C: BIP157)의 공유 전송 계약.
//
// 왜 이 파일이 먼저 고정되는가: B·C·D 를 최대 병렬로 제작하므로(2026-07-31
// 사용자 지시), 서로를 기다리지 않으려면 결합점이 되는 바이트 전송 표면 하나가
// 먼저 확정되어야 한다. ExchangePane 때 구조적 타입으로 병렬을 푼 것과 같은 수법.
//
// 구현체(각자 딴 곳에서 병렬 제작):
//   - node net 소켓        → 테스트·릴레이 서버 (scripts/btc-relay)
//   - Capacitor 플러그인   → 안드로이드 (apps/android)
//   - Tauri 커맨드         → 데스크톱 (apps/desktop)
//   - WebSocket 릴레이     → 확장·웹 (D 경로 — 릴레이 뒤에서 이 계약으로 수렴)
//
// 규칙:
//   - 이 파일은 **계약만** 담는다. 구현·의존성 금지 (어느 셸에서도 import 가능해야).
//   - 필드 추가는 허용, 기존 시그니처 변경은 전 부대 합의 없이는 금지.

/** 원시 바이트 스트림 전송. Electrum(JSON 줄바꿈)·BIP157(길이 프리픽스) 공용. */
export interface ByteTransport {
  /** 연결. tls 는 Electrum 50002 류 TLS 포트용 — 구현이 못 하면 예외를 던진다. */
  connect(host: string, port: number, opts?: ByteTransportOptions): Promise<void>;
  /** 바이트 전송. 연결 전이면 예외. */
  send(bytes: Uint8Array): Promise<void>;
  /** 수신 콜백 — 스트림 조각이 그대로 온다. 줄/메시지 조립은 프로토콜 계층의 몫. */
  onData(cb: (bytes: Uint8Array) => void): void;
  /** 종료 콜백. err 가 있으면 비정상 종료. */
  onClose(cb: (err?: Error) => void): void;
  close(): Promise<void>;
}

export interface ByteTransportOptions {
  tls?: boolean;
  /** 연결 시도 상한 (ms). 기본은 구현이 정하되 8000 권장 — 첫 화면을 막지 않는다. */
  timeoutMs?: number;
}

/** 구현이 이 계약을 만족하는지 구조적으로 검사 (셸이 주입 전 확인용). */
export function isByteTransport(v: unknown): v is ByteTransport {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as ByteTransport;
  return (
    typeof t.connect === 'function' &&
    typeof t.send === 'function' &&
    typeof t.onData === 'function' &&
    typeof t.onClose === 'function' &&
    typeof t.close === 'function'
  );
}
