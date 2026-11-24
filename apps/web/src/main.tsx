import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { APP_NAME } from './config';
import { App } from './App';
import { startNetworkMonitor } from './lib/connectivity';
import './theme/tokens.css';
import './theme/base.css';

document.title = APP_NAME;
startNetworkMonitor();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => undefined); });
}
