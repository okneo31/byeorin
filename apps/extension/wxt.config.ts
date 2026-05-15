import { defineConfig } from 'wxt';

// 노동자의 지갑 — WXT 빌드 구성 (MV3)
// 아이콘 placeholder: 실제 PNG는 packages/design-system 에서 공급 예정.
// public/icon/{16,32,48,128}.png 는 디자인 자원 합류 후 채워 넣는다.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  outDir: '.output',
  manifest: {
    name: '노동자의 지갑',
    description: 'TTL 생태계 멀티체인 월릿 (EIP-1193 호환)',
    permissions: ['storage'],
    action: {
      default_title: '노동자의 지갑',
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
  },
});
