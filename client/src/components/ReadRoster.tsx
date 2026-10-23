import type { Group } from '../../../shared/protocol';
import type { ChatMessage, GroupReads, Messenger, PartRead } from '../lib/messenger';

// Read rosters. Every member sees the same thing: who opened which part of
// which message, how many times, and whether they read all of it. Only part
// numbers are shown, never message text.

const fmt = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

function describe(i: number, p: PartRead | undefined) {
  if (!p) return `Part ${i + 1}: not opened`;
  const times = `opened ${p.opens}× (first ${fmt(p.first)}, last ${fmt(p.last)})`;
  return `Part ${i + 1}: ${p.read ? `read ${fmt(p.readAt ?? p.first)}` : 'opened, not fully read'}, ${times}`;
}

function PartCell({ i, p }: { i: number; p?: PartRead }) {
  const label = describe(i, p);
  return (
    <span className={p ? (p.read ? 'cell read' : 'cell opened') : 'cell'} title={label} aria-label={label}>
      {p && p.opens > 1 ? p.opens : ''}
    </span>
  );
}

function totals(parts: Record<number, PartRead> | undefined) {
  const list = Object.values(parts ?? {});
  return { read: list.filter((p) => p.read).length, opens: list.reduce((n, p) => n + p.opens, 0) };
}

function MessageGrid({ m, group, msg, reads }: { m: Messenger; group: Group; msg: ChatMessage; reads: GroupReads }) {
  const readers = group.members.filter((u) => u.id !== msg.senderId);
  const byUser = reads[msg.id] ?? {};
  if (!readers.length) return <p className="muted small">Nobody else is in this group yet.</p>;
  return (
    <div className="grid-scroll">
      <table className="roster-grid">
        <thead>
          <tr>
            <th scope="col">Member</th>
            {msg.chunks.map((_, i) => (
              <th scope="col" key={i}>
                {i + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {readers.map((u) => {
            const t = totals(byUser[u.id]);
            return (
              <tr key={u.id}>
                <th scope="row">
                  {u.name}
                  {u.id === m.user.id && <span className="muted"> (you)</span>}
                  <span className="muted small">
                    {' '}
                    {t.read}/{msg.chunks.length}
                    {t.opens ? ` · ${t.opens}×` : ''}
                  </span>
                </th>
                {msg.chunks.map((_, i) => (
                  <td key={i}>
                    <PartCell i={i} p={byUser[u.id]?.[i]} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Legend() {
  return (
    <p className="legend small muted">
      <span className="cell" /> not opened <span className="cell opened" /> opened <span className="cell read" /> read
      <span className="legend-n">2</span> times opened
    </p>
  );
}

// One message, opened from the receipt dots under it.
export function MessageRoster({ m, group, msg, reads }: { m: Messenger; group: Group; msg: ChatMessage; reads: GroupReads }) {
  return (
    <div className="roster">
      <p className="muted small">
        Sent by <strong>{m.memberName(msg.senderId)}</strong> · {fmt(msg.sentAt)} · {msg.chunks.length} parts
      </p>
      <MessageGrid m={m} group={group} msg={msg} reads={reads} />
      <Legend />
    </div>
  );
}

// The whole group: per-member totals, then every message, newest first.
export function GroupRosterScreen({ m, group, onOpenMessage }: { m: Messenger; group: Group; onOpenMessage: (msgId: string) => void }) {
  const messages = m.getMessages(group.id);
  const reads = m.getReads(group.id);
  return (
    <div className="roster">
      <section>
        <h3>Members</h3>
        <ul className="member-progress">
          {group.members.map((u) => {
            let total = 0;
            let read = 0;
            let opens = 0;
            let started = 0;
            for (const msg of messages) {
              if (msg.senderId === u.id) continue;
              total += msg.chunks.length;
              const t = totals(reads[msg.id]?.[u.id]);
              read += t.read;
              opens += t.opens;
              if (t.opens) started++;
            }
            const pct = total ? Math.round((read / total) * 100) : 0;
            return (
              <li key={u.id}>
                <div className="row-between">
                  <span>
                    {u.name}
                    {u.id === m.user.id && <span className="muted"> (you)</span>}
                  </span>
                  <span className="muted small">
                    {read}/{total} parts read · {opens} open{opens === 1 ? '' : 's'} · {started} message{started === 1 ? '' : 's'} opened
                  </span>
                </div>
                <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h3>Messages · {messages.length}</h3>
        {messages.length === 0 && <p className="muted small">No messages yet.</p>}
        <ol className="roster-messages">
          {[...messages].reverse().map((msg) => (
            <li key={msg.id}>
              <button className="roster-msg-head" onClick={() => onOpenMessage(msg.id)}>
                <strong>{msg.senderId === m.user.id ? 'You' : m.memberName(msg.senderId)}</strong>
                <span className="muted small">
                  {fmt(msg.sentAt)} · {msg.chunks.length} parts
                </span>
              </button>
              <MessageGrid m={m} group={group} msg={msg} reads={reads} />
            </li>
          ))}
        </ol>
        {messages.length > 0 && <Legend />}
      </section>
    </div>
  );
}
