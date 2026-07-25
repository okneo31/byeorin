import type { CapacitorConfig } from '@capacitor/cli';

// 벼린 — Capacitor(안드로이드) 구성.
//
// androidScheme: 'https'  → WebView 오리진이 `https://localhost` 가 된다.
//   이게 중요한 이유 두 가지:
//     1) secure context 라서 `crypto.subtle` 이 살아 있다 — 키스토어(AES-GCM)가
//        여기에 의존한다. http:// 스킴이면 subtle 이 undefined 가 되어 잠금
//        해제 자체가 불가능해진다.
//     2) localStorage 가 앱 데이터에 영속된다 (앱을 지우기 전까지 유지).
//
// CapacitorHttp 는 **끄고** 간다. 9 체인 RPC 를 전부 실측한 결과
// `ACAO: *` 라 브라우저 fetch 로 그냥 통과하며, 전역 fetch 패치는 viem 의
// AbortSignal / 스트리밍 처리와 충돌할 여지가 있다. CORS 헤더가 없는 유일한
// 엔드포인트(ZION AMM 인덱서 api.zion1.top)만 src/native-http.ts 가 플러그인
// 호출로 개별 우회한다.
const config: CapacitorConfig = {
  appId: 'top.ttl1.byeorin',
  appName: '벼린',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    // 평문 HTTP 로의 다운그레이드를 막는다 — 모든 RPC 가 https 다.
    allowMixedContent: false,
    // WebView 디버깅은 debug 빌드에서만 켠다 (release 는 Capacitor 가 자동으로 끔).
    webContentsDebuggingEnabled: true,
  },
  plugins: {
    CapacitorHttp: { enabled: false },
  },
};

export default config;
