import { useEffect, useReducer, useState } from 'react';
import type { AuthResponse } from '../../shared/protocol';
import { AuthScreen } from './components/AuthScreen';
import { CaptureShield } from './components/CaptureShield';
import { ChatView } from './components/ChatView';
import { GroupPanel } from './components/GroupPanel';
import { MessageRoster } from './components/ReadRoster';
import { API_BASE, WS_URL } from './lib/endpoint';
import { initialInvite, parseInvite, shareInvite, takePendingInvite, watchInvites } from './lib/invite';
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
  const [invite, setInvite] = useState<string | null>(initialInvite);
  const [shareNote, setShareNote] = useState('');

  useEffect(() => {
    let stop = () => {};
    watchInvites(setInvite).then((s) => (stop = s));
    return () => stop();
  }, []);

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
        <AuthScreen onAuthed={signIn} inviting={!!invite} />
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

  const invitePeople = async () => {
    if (!group) return;
    const result = await shareInvite(group).catch(() => 'failed' as const);
    if (result === 'copied') setShareNote('Invite link copied');
    else if (result === 'failed') setShareNote('Could not share the link');
    else return;
    setTimeout(() => setShareNote(''), 2500);
  };
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
        <button className="rail-item add" title="Join a group" aria-label="Join a group with an invite link or code" onClick={() => setDialog('join')}>
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
            <div className="row">
              <button className="btn small primary" onClick={invitePeople}>
                {shareNote || 'Invite'}
              </button>
              <button className="btn small" onClick={() => setPanel(panel?.kind === 'group' ? null : { kind: 'group' })}>
                Members
              </button>
            </div>
          )}
        </header>
        {group ? (
          <ChatView m={m} group={group} onInvite={invitePeople} onOpenRoster={(msgId) => setPanel({ kind: 'message', msgId })} />
        ) : (
          <div className="empty-state">
            <h2>Welcome, {m.user.name}</h2>
            <p className="muted">Create a group and invite people, or open an invite link a friend sent you.</p>
            <div className="row">
              <button className="btn primary" onClick={() => setDialog('create')}>
                Create group
              </button>
              <button className="btn" onClick={() => setDialog('join')}>
                Join a group
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
            <GroupPanel m={m} group={group} onInvite={invitePeople} onLeft={() => (setPanel(null), setGroupId(null))} />
          ) : panelMsg ? (
            <MessageRoster m={m} group={group} msg={panelMsg} reads={m.getReads(group.id)} />
          ) : null}
        </aside>
      )}

      {dialog && <GroupDialog m={m} kind={dialog} onClose={(id) => (setDialog(null), id && setGroupId(id))} />}

      {invite && (
        <InvitePrompt
          m={m}
          code={invite}
          onClose={(id) => {
            takePendingInvite();
            setInvite(null);
            if (id) setGroupId(id);
          }}
        />
      )}
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
            let g;
            if (kind === 'create') g = await m.createGroup(value);
            else {
              const code = parseInvite(value);
              if (!code) throw new Error('Paste the invite link or code your friend sent you.');
              g = await m.joinGroup(code);
            }
            onClose(g.id);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <h2>{kind === 'create' ? 'Create a group' : 'Join a group'}</h2>
        <label>
          {kind === 'create' ? 'Group name' : 'Invite link or code'}
          <input
            autoFocus
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={kind === 'create' ? 60 : 300}
            placeholder={kind === 'join' ? 'https://…/join/…' : undefined}
          />
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

interface InvitePreview {
  groupId: string;
  name: string;
  memberCount: number;
  alreadyMember: boolean;
}

// Shown after opening an invite link: confirm before joining.
function InvitePrompt({ m, code, onClose }: { m: Messenger; code: string; onClose: (groupId?: string) => void }) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    m.api<InvitePreview>('GET', `/api/invites/${encodeURIComponent(code)}`)
      .then((p) => (p.alreadyMember ? onClose(p.groupId) : setPreview(p)))
      .catch((e: Error) => setError(e.message));
  }, [m, code]);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-labelledby="invite-title">
        <h2 id="invite-title">{preview ? `Join ${preview.name}?` : error ? 'Invite not valid' : 'Opening invite…'}</h2>
        {preview && (
          <p className="muted">
            {preview.memberCount} member{preview.memberCount === 1 ? '' : 's'}. Messages are end-to-end encrypted; you
            will see messages sent after you join.
          </p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={() => onClose()}>
            {preview ? 'Not now' : 'Close'}
          </button>
          {preview && (
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  onClose((await m.joinGroup(code)).id);
                } catch (e) {
                  setError((e as Error).message);
                  setBusy(false);
                }
              }}
            >
              Join group
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
