import { useEffect, useReducer, useState } from 'react';
import type { AuthResponse } from '../../shared/protocol';
import { AuthScreen } from './components/AuthScreen';
import { CaptureShield } from './components/CaptureShield';
import { ChatView } from './components/ChatView';
import { GroupPanel } from './components/GroupPanel';
import { MessageRoster } from './components/ReadRoster';
import { API_BASE, WS_URL } from './lib/endpoint';
import { idbKV } from './lib/kv';
import { Messenger } from './lib/messenger';

const SESSION_KEY = 'secure-chat:session';

function loadSession(): AuthResponse | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function App() {
  const [session, setSession] = useState<AuthResponse | null>(loadSession);
  const [m, setM] = useState<Messenger | null>(null);
  const [startError, setStartError] = useState('');
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ kind: 'group' } | { kind: 'message'; msgId: string } | null>(null);
  const [dialog, setDialog] = useState<'create' | 'join' | null>(null);

  useEffect(() => {
    if (!session) return;
    const messenger = new Messenger({
      baseUrl: API_BASE,
      wsUrl: WS_URL,
      token: session.token,
      user: session.user,
      kv: idbKV(session.user.id),
    });
    const unsub = messenger.subscribe(rerender);
    setStartError('');
    let cancelled = false;
    // Deferred so a mount that is immediately torn down (StrictMode) never
    // starts generating keys in parallel with the real one.
    const timer = setTimeout(() =>
      messenger
        .start()
        .then(() => !cancelled && setM(messenger))
        .catch((e: Error) => {
          if (cancelled) return;
          if (/not signed in/i.test(e.message)) signOut();
          else setStartError(e.message);
        }),
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsub();
      messenger.stop();
      setM(null);
    };
  }, [session]);

  const signIn = (a: AuthResponse) => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(a));
    setSession(a);
  };

  const signOut = () => {
    if (session) fetch(`${API_BASE}/api/logout`, { method: 'POST', headers: { authorization: `Bearer ${session.token}` } }).catch(() => {});
    localStorage.removeItem(SESSION_KEY);
    setSession(null);
    setGroupId(null);
    setPanel(null);
  };

  if (!session) {
    return (
      <>
        <AuthScreen onAuthed={signIn} />
      </>
    );
  }

  if (!m) {
    return (
      <main className="auth">
        <div className="auth-card">
          {startError ? (
            <>
              <p className="error">{startError}</p>
              <button className="btn" onClick={() => setSession({ ...session })}>
                Retry
              </button>
              <button className="link" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <p className="muted">Setting up encryption keys…</p>
          )}
        </div>
      </main>
    );
  }

  const group = m.groups.find((g) => g.id === groupId) ?? m.groups[0] ?? null;
  const panelMsg = panel?.kind === 'message' && group ? m.getMessages(group.id).find((x) => x.id === panel.msgId) : undefined;

  return (
    <div className={panel ? 'app with-panel' : 'app'}>
      <CaptureShield />
      <nav className="rail" aria-label="Groups">
        {m.groups.map((g) => (
          <button
            key={g.id}
            className={g.id === group?.id ? 'rail-item active' : 'rail-item'}
            title={g.name}
            aria-label={g.name}
            aria-current={g.id === group?.id}
            onClick={() => {
              setGroupId(g.id);
              setPanel(null);
            }}
          >
            {g.name.slice(0, 2).toUpperCase()}
          </button>
        ))}
        <button className="rail-item add" title="Create group" aria-label="Create group" onClick={() => setDialog('create')}>
          +
        </button>
        <button className="rail-item add" title="Join with invite" aria-label="Join with invite code" onClick={() => setDialog('join')}>
          ⇢
        </button>
        <div className="rail-spacer" />
        <button className="rail-item me" title={`Signed in as ${m.user.name}. Sign out`} aria-label="Sign out" onClick={signOut}>
          {m.user.name.slice(0, 1).toUpperCase()}
        </button>
      </nav>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h2>{group ? group.name : 'No group'}</h2>
            <span className={m.connected ? 'status on' : 'status'}>{m.connected ? 'E2E encrypted' : 'Reconnecting…'}</span>
          </div>
          {group && (
            <button className="btn small" onClick={() => setPanel(panel?.kind === 'group' ? null : { kind: 'group' })}>
              Members
            </button>
          )}
        </header>
        {group ? (
          <ChatView m={m} group={group} onOpenRoster={(msgId) => setPanel({ kind: 'message', msgId })} />
        ) : (
          <div className="empty-state">
            <h2>Welcome, {m.user.name}</h2>
            <p className="muted">Create a group, or join one with an invite code from a friend.</p>
            <div className="row">
              <button className="btn primary" onClick={() => setDialog('create')}>
                Create group
              </button>
              <button className="btn" onClick={() => setDialog('join')}>
                Join with code
              </button>
            </div>
          </div>
        )}
      </main>

      {panel && group && (
        <aside className="panel" aria-label={panel.kind === 'group' ? 'Group members' : 'Read roster'}>
          <header className="topbar">
            <h2>{panel.kind === 'group' ? 'Members' : 'Who read what'}</h2>
            <button className="btn small" onClick={() => setPanel(null)} aria-label="Close panel">
              ✕
            </button>
          </header>
          {panel.kind === 'group' ? (
            <GroupPanel m={m} group={group} onLeft={() => (setPanel(null), setGroupId(null))} />
          ) : panelMsg ? (
            <MessageRoster m={m} group={group} msg={panelMsg} reads={m.getReads(group.id)} />
          ) : null}
        </aside>
      )}

      {dialog && <GroupDialog m={m} kind={dialog} onClose={(id) => (setDialog(null), id && setGroupId(id))} />}
    </div>
  );
}

function GroupDialog({ m, kind, onClose }: { m: Messenger; kind: 'create' | 'join'; onClose: (groupId?: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const g = kind === 'create' ? await m.createGroup(value) : await m.joinGroup(value);
            onClose(g.id);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <h2>{kind === 'create' ? 'Create a group' : 'Join a group'}</h2>
        <label>
          {kind === 'create' ? 'Group name' : 'Invite code'}
          <input autoFocus required value={value} onChange={(e) => setValue(e.target.value)} maxLength={60} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={() => onClose()}>
            Cancel
          </button>
          <button className="btn primary">{kind === 'create' ? 'Create' : 'Join'}</button>
        </div>
      </form>
    </div>
  );
}
