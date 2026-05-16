import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  I18nProvider,
  createChromeSyncLocaleStorage,
} from '@nodong/i18n/react';
import { App } from './App.js';
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
