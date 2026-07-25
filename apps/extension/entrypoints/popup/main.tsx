// Buffer polyfill — popup 의 멀티체인 청크(cosmos/ton/xrp/solana 등)가 평가될 때
// Node 의 Buffer 를 참조한다. MV3 브라우저 컨텍스트엔 Buffer 가 없으므로 popup 부팅
// 시점에 globalThis.Buffer 를 채워둔다. 다른 어떤 import 보다 먼저 실행돼야
// multichain dynamic import 가 평가 단계에서 ReferenceError 를 던지지 않는다.
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
// 디자인 시스템 토큰을 먼저 로드해 styles.css 에서 var(--nd-*) 가 참조 가능하도록 한다.
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
