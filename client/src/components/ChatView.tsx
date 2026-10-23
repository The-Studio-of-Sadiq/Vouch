import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Group } from '../../../shared/protocol';
import { WORDS_PER_CHUNK } from '../lib/chunks';
import type { ChatMessage, GroupReads, Messenger } from '../lib/messenger';
import { RevealChunk } from './RevealChunk';

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function useBubbleWidth() {
  const [w, setW] = useState(() => Math.min(420, window.innerWidth - 140));
  useEffect(() => {
    const on = () => setW(Math.min(420, window.innerWidth - 140));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return Math.max(160, w);
}

function MessageItem({
  m,
  group,
  msg,
  reads,
  width,
  onOpenRoster,
}: {
  m: Messenger;
  group: Group;
  msg: ChatMessage;
  reads: GroupReads;
  width: number;
  onOpenRoster: () => void;
}) {
  const mine = msg.senderId === m.user.id;
  const others = group.members.filter((u) => u.id !== msg.senderId).length;
  const byUser = reads[msg.id] ?? {};
  const myReads = byUser[m.user.id] ?? {};
  const fullyRead = Object.values(byUser).filter((r) => Object.keys(r).length >= msg.chunks.length).length;

  return (
    <li className={mine ? 'msg mine' : 'msg'}>
      <div className="msg-head">
        <strong>{mine ? 'You' : m.memberName(msg.senderId)}</strong>
        <span className="muted small">{time(msg.sentAt)}</span>
      </div>
      <div className="chunks">
        {msg.chunks.map((c, i) => (
          <RevealChunk
            key={i}
            index={i}
            text={c}
            maxWidth={width}
            read={mine || !!myReads[i]}
            onRead={() => !mine && m.markRead(group.id, msg.id, i)}
          />
        ))}
      </div>
      <button className="receipts" onClick={onOpenRoster} aria-label="Show who read which part">
        <span className="dots" aria-hidden>
          {msg.chunks.map((_, i) => {
            const n = Object.values(byUser).filter((r) => r[i]).length;
            const level = others ? n / others : 0;
            return <i key={i} style={{ opacity: 0.25 + 0.75 * level }} className={level >= 1 ? 'full' : ''} />;
          })}
        </span>
        <span className="small muted">
          {others === 0 ? 'No readers yet' : `${fullyRead}/${others} read all`}
        </span>
      </button>
    </li>
  );
}

export function ChatView({
  m,
  group,
  onOpenRoster,
  onInvite,
}: {
  m: Messenger;
  group: Group;
  onOpenRoster: (msgId: string) => void;
  onInvite: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const messages = m.getMessages(group.id);
  const reads = m.getReads(group.id);
  const width = useBubbleWidth();
  const warned = group.members.filter((u) => m.identityWarnings.has(u.id));

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, group.id]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    try {
      await m.sendText(group.id, text);
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const words = draft.trim() ? draft.trim().split(/\s+/).length : 0;

  return (
    <div className="chat">
      {warned.length > 0 && (
        <div className="banner warn">
          Safety number changed for {warned.map((u) => u.name).join(', ')}. Verify in the members panel.
        </div>
      )}
      <ol className="messages" ref={listRef}>
        {group.members.length === 1 && (
          <li className="empty alone">
            <p>
              <strong>You're the only one here.</strong>
            </p>
            <p className="muted small">Send an invite link to the people you want in this group.</p>
            <button className="btn primary" onClick={onInvite}>
              Invite people
            </button>
          </li>
        )}
        {messages.length === 0 && group.members.length > 1 && (
          <li className="empty">
            <p>No messages yet.</p>
            <p className="muted small">
              Every message is end-to-end encrypted and split into parts of {WORDS_PER_CHUNK} words. Readers press and
              hold a part to reveal it a few letters at a time, and everyone can see who read which part.
            </p>
          </li>
        )}
        {messages.map((msg) => (
          <MessageItem
            key={msg.id}
            m={m}
            group={group}
            msg={msg}
            reads={reads}
            width={width}
            onOpenRoster={() => onOpenRoster(msg.id)}
          />
        ))}
      </ol>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          value={draft}
          placeholder={`Message ${group.name}`}
          rows={1}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn primary" disabled={!words || sending || !m.connected}>
          Send
        </button>
        <div className="composer-meta small muted">
          {error ? (
            <span className="error">{error}</span>
          ) : words ? (
            `${Math.ceil(words / WORDS_PER_CHUNK)} part${words > WORDS_PER_CHUNK ? 's' : ''} · encrypted for ${group.members.length - 1} member${group.members.length === 2 ? '' : 's'}`
          ) : (
            'Enter to send · Shift+Enter for a new line'
          )}
        </div>
      </form>
    </div>
  );
}
