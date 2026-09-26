import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

function StartupReady() {
  useEffect(() => {
    (window as Window & { aiDuoStartupReady?: () => void }).aiDuoStartupReady?.();
  }, []);
  return null;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <>
      <StartupReady />
      <App />
    </>
  </StrictMode>,
);
