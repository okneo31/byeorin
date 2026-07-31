// btc-history.ts — BTC 이력 트랙 공개 배럴 (@byeorin/wallet-sdk/btc-history).
//
// 두 갈래 + 공유 전송 계약:
//   electrum/  — Electrum 프로토콜 (서버 필요, 함수 5개로 즉시 이력)
//   bip157/    — BIP157/158 라이트클라이언트 (제3자 서버 0, P2P 직접 스캔)
//   transport  — ByteTransport 계약. 구현체는 각 셸이 주입한다:
//     안드로이드 apps/android/src/native-tcp.ts (Capacitor 플러그인)
//     데스크톱   apps/desktop/src/native-tcp.ts (Tauri 커맨드)
//     확장·웹    apps/*/src/lib/ws-tcp-transport.ts (WS 릴레이 scripts/btc-relay)

export * from './btc-history/transport.js';
export * from './btc-history/electrum/index.js';
export * from './btc-history/bip157/index.js';
