import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  I18nProvider,
  createChromeSyncLocaleStorage,
} from '@byeorin/i18n/react';
import { App } from './App.js';
// 디자인 시스템 토큰 + .nd-* 컴포넌트 베이스 스타일.
// confirm popup 은 다크 테마이므로 styles.css 에서 일부 색상을 오버라이드한다.
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
