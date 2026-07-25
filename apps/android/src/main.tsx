// Buffer polyfill — 멀티체인 청크(cosmos/ton/xrp/solana 등)가 평가되는 순간
// Node 의 Buffer 를 참조한다. WebView 에도 Buffer 는 없으므로 어떤 import 보다
// 먼저 globalThis 에 심어야 dynamic import 가 ReferenceError 로 죽지 않는다.
// (확장 popup 의 main.tsx 와 동일한 이유·동일한 순서.)
import { Buffer as BufferPolyfill } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as unknown as { Buffer: typeof BufferPolyfill }).Buffer = BufferPolyfill;
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  I18nProvider,
  createLocalStorageLocaleStorage,
} from '@byeorin/i18n/react';
import { App } from './App.js';
import '@byeorin/design-system/tokens.css';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element not found');

createRoot(container).render(
  <React.StrictMode>
    <I18nProvider persistence={createLocalStorageLocaleStorage('byeorin:locale')}>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
