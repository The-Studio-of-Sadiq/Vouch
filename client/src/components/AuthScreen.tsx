import { useEffect, useState } from 'react';
import type { AuthResponse } from '../../../shared/protocol';
import { API_BASE } from '../lib/endpoint';

export function AuthScreen({
  onAuthed,
  inviting = false,
  notice = '',
}: {
  onAuthed: (a: AuthResponse) => void;
  inviting?: boolean;
  notice?: string;
}) {
  // Someone arriving from an invite link most likely has no account yet.
  const [mode, setMode] = useState<'login' | 'register'>(inviting ? 'register' : 'login');
  // A native app link can arrive after the first render.
  useEffect(() => {
    if (inviting) setMode('register');
  }, [inviting]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, name, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
      onAuthed(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <span className="logo" aria-hidden>◈</span>
          <h1>Veil</h1>
        </div>
        <p className="muted">End-to-end encrypted group chat. Messages are revealed a few letters at a time.</p>
        {notice && (
          <p className="banner warn" role="alert">
            {notice}
          </p>
        )}
        {mode === 'login' && !notice && (
          <p className="small muted">Signing in here signs your account out of any other phone. One device per account.</p>
        )}
        {inviting && (
          <p className="banner invite-banner">You've been invited to a group. Create an account or sign in to join it.</p>
        )}
        <label>
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode === 'register' && (
          <label>
            Display name
            <input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={mode === 'register' ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy}>
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}
        </button>
      </form>
    </main>
  );
}
