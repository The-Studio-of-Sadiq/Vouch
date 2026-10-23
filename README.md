# Veil: secure group chat

An end-to-end encrypted, Discord-style group chat built on the Signal Protocol.
Messages are split into word chunks that start out masked. Readers press and
hold a chunk to reveal it through a small sliding window, and every member can
see who has read which chunk.

Successor to the Flutter/Firebase prototype in [anonymous-chatapp](https://github.com/princekhan7748/anonymous-chatapp).

## Run it

Requires Node 22.5+ (uses the built-in `node:sqlite`).

```bash
git clone https://github.com/princekhan7748/veil-secure-chat.git && cd veil-secure-chat
npm install
npm run dev --workspace server   # API + relay on :8787
npm run dev --workspace client   # UI on :5173 (proxies to :8787)
```

Production: `npm run build --workspace client`, then `npm start --workspace server`
serves the built UI and the API from port 8787. Put it behind HTTPS.

### Android app (OS-level screenshot blocking)

`client/android` is a Capacitor shell around the same client. `MainActivity`
sets `FLAG_SECURE`, so Android refuses screenshots and screen recordings,
casting shows a black screen, and the app's preview in recent apps is blank.
Backups and device-to-device transfer are turned off, so the Signal keys
stored in the app never leave the phone.

Requires JDK 21 and the Android SDK (platform 36). Android Studio provides
both, or set `JAVA_HOME` and `ANDROID_HOME` yourself.

```bash
cd client
npm run android:dev    # UI points at http://10.0.2.2:8787 (the host, seen from the emulator)
npm run android:apk    # -> android/app/build/outputs/apk/debug/app-debug.apk
```

For a real device or a release, build with your HTTPS server instead:
`VITE_SERVER_URL=https://chat.example.com npm run android:release`, then build
from Android Studio. Release builds refuse plain HTTP. The cleartext
exception for `10.0.2.2`/`localhost` is only in the debug source set. The
server already allows requests from the app's `https://localhost` origin. If
you need more origins, add them with `CORS_ORIGINS`.

Tests (real server + three in-memory clients):

```bash
npm test
```

## How it works

| Piece | What it does |
| --- | --- |
| `client/src/lib/messenger.ts` | Signal sessions (X3DH + Double Ratchet via `libsignal-protocol-typescript`), pairwise group fan-out, encrypted read receipts, local storage |
| `client/src/lib/signal-store.ts` | Persists identity, prekeys and ratchet state in IndexedDB |
| `client/src/components/RevealChunk.tsx` | Canvas-rendered chunk with a sliding reveal window |
| `client/src/components/CaptureShield.tsx` | Screenshot/recording deterrence |
| `client/src/components/ReadRoster.tsx` | Per-message member × chunk grid, per-group progress |
| `server/src/app.ts` | Accounts, prekey directory, group membership, store-and-forward relay |

**Encryption.** Each device generates its Signal identity locally. The private
keys never leave IndexedDB. A group message is encrypted separately for each
member over that pair's own Double Ratchet session (the way Signal handled
groups before sender keys). Read receipts are ordinary encrypted messages too.

**Reading.** Messages are split every 4 words (`WORDS_PER_CHUNK`). The text is
painted on a `<canvas>` only while the chunk is held, so the plaintext is never
in the DOM. A window of about 4 characters sweeps across the chunk. The chunk
counts as read only after the window has covered all of it.

**Verification.** Members → Verify shows a 60-digit safety number. If two
people's numbers match, nobody is in the middle. When a member's key changes,
the app flags it.

## What the server can and cannot see

The server sees accounts (email and display name), group names and membership,
public keys, and who sent an encrypted envelope to whom, when, and how big it
was. It never sees message text, which chunks anyone read, or read times.
Envelopes are deleted once the recipient acknowledges them.

## Known limits

- **Screenshots.** The Android app blocks them at the OS level with
  `FLAG_SECURE`. Rooted devices and a camera pointed at the screen can still
  get around it. In a browser nothing can block OS screenshots. There, the
  capture shield blanks the app whenever the window loses focus, the tab is
  hidden, or a screenshot shortcut is pressed. It also blocks printing,
  selection, copy and the context menu. On both, the sliding window means any
  single frame shows only a fragment. iOS has no equivalent yet; it would need
  a Capacitor iOS shell that hides content while `UIScreen.isCaptured`.
- **One device per account.** Signing in on a new browser creates a new
  identity. Other members see "key changed", and history stays on the old
  device.
- **No signed-prekey rotation** and no sender keys yet. Fan-out cost grows
  with group size.
- **Accessibility.** Screen readers can't read hidden chunks. That's
  inherent to the design.
- `@privacyresearch/libsignal-protocol-typescript` is **GPL-3.0**, so the
  distributed client is GPL-3.0 as well.
