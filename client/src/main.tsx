import { Capacitor } from '@capacitor/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Veil is Android-only by design: a browser has no OS-level screenshot
// blocking and keeps keys in storage the user can't protect. The dev server is
// the only exception, and the API refuses browser origins in production anyway.
const supported = Capacitor.isNativePlatform() || import.meta.env.DEV;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {supported ? (
      <App />
    ) : (
      <main className="auth">
        <div className="auth-card">
          <h1>Veil</h1>
          <p className="muted">Veil runs only as an Android app. There is no browser version.</p>
        </div>
      </main>
    )}
  </StrictMode>,
);
