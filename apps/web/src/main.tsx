import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// 디자인 시스템 토큰을 먼저 로드해 컴포넌트가 동일한 변수를 사용하도록 한다.
// 로컬 styles.css는 이후에 와서 앱 레벨 레이아웃을 덮어쓸 수 있다.
import '@nodong/design-system/tokens.css';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('root element not found');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
