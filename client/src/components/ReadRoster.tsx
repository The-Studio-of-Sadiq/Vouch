import type { Group } from '../../../shared/protocol';
import type { ChatMessage, GroupReads, Messenger } from '../lib/messenger';

const fmt = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

// Members × chunks grid for one message: who has revealed which part, and when.
// Shows chunk numbers only, never the text itself.
export function MessageRoster({ m, group, msg, reads }: { m: Messenger; group: Group; msg: ChatMessage; reads: GroupReads }) {
  const readers = group.members.filter((u) => u.id !== msg.senderId);
  const byUser = reads[msg.id] ?? {};
  return (
    <div className="roster">
      <p className="muted small">
        Sent by <strong>{m.memberName(msg.senderId)}</strong> · {fmt(msg.sentAt)} · {msg.chunks.length} parts
      </p>
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
              const r = byUser[u.id] ?? {};
              const n = Object.keys(r).length;
              return (
                <tr key={u.id}>
                  <th scope="row">
                    {u.name}
                    {u.id === m.user.id && <span className="muted"> (you)</span>}
                    <span className="muted small"> {n}/{msg.chunks.length}</span>
                  </th>
                  {msg.chunks.map((_, i) => (
                    <td key={i}>
                      <span
                        className={r[i] ? 'cell read' : 'cell'}
                        title={r[i] ? `Read ${fmt(r[i])}` : 'Not read'}
                        aria-label={`Part ${i + 1}: ${r[i] ? `read ${fmt(r[i])}` : 'not read'}`}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {readers.length === 0 && <p className="muted">Nobody else is in this group yet.</p>}
    </div>
  );
}

// Group-level summary: how much of everyone else's messages each member has read.
export function GroupRoster({ m, group }: { m: Messenger; group: Group }) {
  const messages = m.getMessages(group.id);
  const reads = m.getReads(group.id);
  return (
    <ul className="member-progress">
      {group.members.map((u) => {
        let total = 0;
        let seen = 0;
        for (const msg of messages) {
          if (msg.senderId === u.id) continue;
          total += msg.chunks.length;
          seen += Object.keys(reads[msg.id]?.[u.id] ?? {}).length;
        }
        const pct = total ? Math.round((seen / total) * 100) : 0;
        return (
          <li key={u.id}>
            <div className="row-between">
              <span>
                {u.name}
                {u.id === m.user.id && <span className="muted"> (you)</span>}
              </span>
              <span className="muted small">
                {seen}/{total} parts
              </span>
            </div>
            <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
