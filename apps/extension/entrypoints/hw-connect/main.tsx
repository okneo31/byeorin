// hw-connect — Ledger(WebHID) 연결 전용 페이지.
//
// 왜 popup 이 아닌 별도 페이지인가:
//   Chrome MV3 의 action popup 은 chooser modal 같은 외부 dialog 가 뜨면
//   blur 되어 자동 닫힌다. popup 이 닫히면 그 안의 JS context 도 destroy 되어
//   navigator.hid.requestDevice() 의 결과를 받지 못한다. MetaMask·Phantom 등
//   모든 wallet extension 이 HW 연결을 별도 tab/window 에서 처리하는 이유.
//
// 흐름:
//   1) popup 의 'Solana 연결' / 'Cosmos 연결' 버튼이 chrome.windows.create 로
//      이 페이지를 새 window 로 띄움 (?app=solana 또는 ?app=cosmos)
//   2) 이 페이지가 WebHID chooser 표시 + 디바이스 선택 → 주소 추출
//   3) 결과를 chrome.storage.session 에 'nd:hw-account' 키로 저장
//   4) popup 이 storage change 를 감지해 HW 카드 갱신
//   5) 이 페이지는 자동 닫기 (window.close)

// Buffer polyfill — popup 과 동일. ledger transport 가 Node Buffer 를 참조한다.
import { Buffer as BufferPolyfill } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as unknown as { Buffer: typeof BufferPolyfill }).Buffer = BufferPolyfill;
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  I18nProvider,
  createChromeSyncLocaleStorage,
} from '@byeorin/i18n/react';
import { App } from './App.js';
import '@byeorin/design-system/tokens.css';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element not found');

createRoot(container).render(
  <React.StrictMode>
    <I18nProvider persistence={createChromeSyncLocaleStorage('nd:locale')}>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
