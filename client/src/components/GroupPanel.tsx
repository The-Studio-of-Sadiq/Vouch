import { useState } from 'react';
import type { Group } from '../../../shared/protocol';
import { inviteLink } from '../lib/invite';
import type { Messenger } from '../lib/messenger';

export function GroupPanel({ m, group, onLeft, onInvite }: { m: Messenger; group: Group; onLeft: () => void; onInvite: () => void }) {
  const [safety, setSafety] = useState<{ userId: string; value: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const isOwner = group.ownerId === m.user.id;

  const showSafety = async (userId: string) => {
    setError('');
    try {
      setSafety({ userId, value: await m.safetyNumber(userId) });
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  return (
    <div className="panel-body">
      <section>
        <h3>Invite</h3>
        <p className="small muted">Anyone with this link can join. They can open it in the app or in a browser.</p>
        <code className="invite-link">{inviteLink(group.inviteCode)}</code>
        <div className="row">
          <button className="btn small primary" onClick={onInvite}>
            Share link
          </button>
          <button
            className="btn small"
            onClick={() =>
              navigator.clipboard
                .writeText(inviteLink(group.inviteCode))
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
                .catch(() => setError('Could not copy. Use Share link instead.'))
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </section>

      <section>
        <h3>Members · {group.members.length}</h3>
        <ul className="members">
          {group.members.map((u) => (
            <li key={u.id}>
              <div className="row-between">
                <span>
                  {u.name}
                  {u.id === group.ownerId && <span className="tag">owner</span>}
                  {m.identityWarnings.has(u.id) && (
                    <span className="tag warn" title="This member's safety number changed">
                      key changed
                    </span>
                  )}
                </span>
                {u.id !== m.user.id && (
                  <span className="actions">
                    <button className="link" onClick={() => showSafety(u.id)}>
                      Verify
                    </button>
                    {isOwner && (
                      <button className="link danger" onClick={() => m.removeMember(group.id, u.id)}>
                        Remove
                      </button>
                    )}
                  </span>
                )}
              </div>
              {safety?.userId === u.id && (
                <div className="safety">
                  <p className="small muted">
                    Compare this safety number with {u.name} in person or over another channel. If it matches, your
                    conversation is end-to-end encrypted with them and nobody is in the middle.
                  </p>
                  <code>{safety.value.match(/.{1,5}/g)?.join(' ')}</code>
                  {m.identityWarnings.has(u.id) && (
                    <button className="btn small" onClick={() => m.dismissIdentityWarning(u.id)}>
                      Mark as verified
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {error && <p className="error">{error}</p>}
      </section>

      <section>
        <button
          className="btn danger"
          onClick={async () => {
            if (!confirm(`Leave ${group.name}?`)) return;
            await m.leaveGroup(group.id);
            onLeft();
          }}
        >
          Leave group
        </button>
      </section>
    </div>
  );
}
