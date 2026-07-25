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
    // ⚠ 이 플래그는 빌드 타입을 구분하지 않는다. true 로 두면 **release APK 에서도**
    // devtools 소켓이 열린다 (실측 확인). 지갑에서는 잠금 해제 중인 평문 시드가
    // JS 힙에 있으므로 그대로 두면 안 된다. 여기서는 끄고, MainActivity 가
    // BuildConfig.DEBUG 일 때만 다시 켠다 — 디버그 APK 의 진단 능력은 유지된다.
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    CapacitorHttp: { enabled: false },
  },
};

export default config;
