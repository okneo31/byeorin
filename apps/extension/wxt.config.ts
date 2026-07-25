import { defineConfig } from 'wxt';

// 벼린 — WXT 빌드 구성 (MV3)
// 아이콘 placeholder: 실제 PNG는 packages/design-system 에서 공급 예정.
// public/icon/{16,32,48,128}.png 는 디자인 자원 합류 후 채워 넣는다.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  outDir: '.output',
  manifest: {
    name: '벼린',
    description: 'TTL 생태계 멀티체인 월릿 (EIP-1193 호환)',
    permissions: ['storage'],
    // ZION (Cosmos) — REST 인덱서, CometBFT RPC, LCD. 다른 체인 RPC 들은
    // 모두 wildcard CORS 라 host_permissions 없이 통과하지만, zion1.top 은
    // CORS 정책이 미상이라 명시적으로 권한을 받아 MV3 가 CORS 검사를 우회하게
    // 한다. (host_permissions 가 있으면 fetch 는 일반 ajax 가 아닌 extension
    // privileged 모드로 나가 CORS 자체가 무력화된다.)
    host_permissions: [
      'https://api.zion1.top/*',
      'https://rpc.zion1.top/*',
      'https://lcd.zion1.top/*',
    ],
    action: {
      default_title: '벼린',
    },
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    // H3 fix: inpage.js 노출도 https + localhost 로 한정. content_scripts matches 와 동기화.
    web_accessible_resources: [
      {
        resources: ['/inpage.js'],
        matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
      },
    ],
    // MV3 popup 의 멀티체인 청크가 WASM 을 컴파일한다 (@solana/web3.js 의 ed25519
    // native impl 등). MV3 기본 CSP 는 'script-src self' 만 허용해 WebAssembly
    // 인스턴스화를 거부한다. Chrome MV3 가 2022년부터 인정한 `'wasm-unsafe-eval'`
    // 키워드로 WASM 만 허용하고 `eval`/inline 은 계속 금지한다 (보안 표면 최소 확장).
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
  },
});
