import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  I18nProvider,
  createChromeSyncLocaleStorage,
} from '@nodong/i18n/react';
import { App } from './App.js';
// 디자인 시스템 토큰을 먼저 로드해 styles.css 에서 var(--nd-*) 가 참조 가능하도록 한다.
import '@nodong/design-system/tokens.css';
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
