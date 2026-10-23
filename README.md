# Veil: secure group chat

An end-to-end encrypted, Discord-style group chat for Android, built on the
Signal Protocol. Messages are split into word chunks that start out masked.
Readers press and hold a chunk to reveal it through a small sliding window, and
every member can see who has read which chunk.

Successor to the Flutter/Firebase prototype in [anonymous-chatapp](https://github.com/princekhan7748/anonymous-chatapp).

## Security model

Veil's protections depend on two rules. Both are deliberate and enforced by the
server. They are not missing features.

### Android only, no browser version

Veil runs only as the Android app. There is no web client, and there won't be.

- **Screenshots can only be blocked by the OS.** The app sets `FLAG_SECURE`, so
  Android refuses screenshots and screen recordings, casting shows a black
  screen, and the app's preview in recent apps is blank. A browser tab can't
  do any of that: any screenshot tool or extension can capture it.
- **Keys stay in a place the user controls.** In the app, Signal keys and
  history live in private app storage, with Android backups and device
  transfer turned off. In a browser they would sit in site storage, readable by
  extensions and synced or wiped by browser settings the app can't see.
- **How it's enforced.** The server no longer serves any web client. Browsers
  always send an `Origin` header on cross-origin and WebSocket requests, and the
  API and relay refuse every origin except the app's own (`https://localhost`,
  the Capacitor WebView). A copy of the client hosted somewhere else gets
  `403 Veil only works in the Android app.` The client also refuses to start
  outside the native shell, except on the local dev server.
- An invite link opened on a device without the app shows a short page
  explaining that Veil is Android-only.

### One device per account

Each account is active on exactly one phone at a time. There is no
multi-device mode, by design.

- **Nobody can silently add a second device.** With multi-device, someone who
  learns your password could link a device of their own and read along
  quietly. In Veil, signing in on a new phone **signs the old phone out**.
  Within seconds the old phone **erases its keys, sessions and message
  history**. Every member of your groups gets a **"safety number changed"**
  warning. A takeover is therefore always visible: you lose access, and your
  contacts are told.
- **Messages exist in exactly one place.** Each message is encrypted for each
  member's one current device, so there is no second copy synced to a laptop
  or tablet that could be lost or seized.
- **History doesn't follow you.** A new phone starts empty. Old messages were
  encrypted for the old phone's keys, which no longer exist anywhere. This is
  intended.
- **How it's enforced.** When a phone uploads a new Signal identity
  (`PUT /api/keys`), the server deletes every other session for that account
  in the same transaction. It sends any connected old phone a `revoked` frame
  and closes its socket. A phone that was offline finds out on its next
  connection, when its token no longer works. Either way, the old phone wipes
  its local database and returns to the sign-in screen with an explanation.
  Signing in again on the same phone, with its keys intact, keeps the same
  identity and signs nothing out.
- **Your part.** If you see "safety number changed" for someone, verify the new
  number with them (Members → Verify) before trusting the conversation again.

## Run it (development)

Requires Node 22.5+ (it uses the built-in `node:sqlite`), JDK 21 and the
Android SDK (platform 36). Android Studio provides the last two, or set
`JAVA_HOME` and `ANDROID_HOME` yourself.

```bash
git clone https://github.com/princekhan7748/veil-secure-chat.git && cd veil-secure-chat
npm install
npm run dev --workspace server        # API + relay on :8787
cd client
npm run android:dev                   # app build pointed at http://10.0.2.2:8787 (the host, seen from the emulator)
npm run android:apk                   # -> android/app/build/outputs/apk/debug/app-debug.apk
```

For quick UI work you can run the client in a desktop browser with
`npm run dev --workspace client`. That only works against a local server
started with `CORS_ORIGINS=http://localhost:5173`, and it's a development tool,
not a supported way to use Veil.

Tests (a real server plus in-memory clients, including the two policies
above):

```bash
npm test
```

## Release

### Server (Fly.io)

The live server is **https://veil-secure-chat.fly.dev**. It runs the API and
relay only. `Dockerfile` and `fly.toml` deploy it as a single machine in
Singapore, with SQLite on an encrypted volume (`veil_data`, mounted at
`/data`). The machine stops when idle and starts on the next request.

```bash
fly deploy --remote-only    # rebuild and roll out
fly logs                    # tail server logs
```

Check a deployment end to end. This creates two throwaway `smoke-*@example.test`
accounts, then exchanges an encrypted message and a read receipt:

```bash
cd client && npx tsx scripts/smoke.ts https://veil-secure-chat.fly.dev
```

### Android app

```bash
cd client
npm run android:release   # -> android/app/build/outputs/apk/release/app-release.apk
```

The release build is signed with the key described by
`~/.veil-signing/keystore.properties`. Set `VEIL_KEYSTORE_PROPERTIES` to use a
different file. That file and the keystore are kept out of git. **Back them up
somewhere safe:** every update has to be signed with the same key, or phones
will refuse to install it over the old version. Invite links also stop opening
the app, because `server/src/pages.ts` publishes this key's fingerprint for
Android App Links. Without the file, the release build comes out unsigned.

Release builds refuse plain HTTP. The cleartext exception for
`10.0.2.2`/`localhost` exists only in debug builds.

## How it works

| Piece | What it does |
| --- | --- |
| `client/src/lib/messenger.ts` | Signal sessions (X3DH + Double Ratchet via `libsignal-protocol-typescript`), pairwise group fan-out, encrypted read receipts, local storage, revocation handling |
| `client/src/lib/signal-store.ts` | Persists identity, prekeys and ratchet state in the app's IndexedDB |
| `client/src/lib/invite.ts` | Invite links, the Android share sheet and App Link handling |
| `client/src/components/RevealChunk.tsx` | Canvas-rendered chunk with a sliding reveal window |
| `client/src/components/CaptureShield.tsx` | Extra in-app capture deterrence on top of `FLAG_SECURE` |
| `client/src/components/ReadRoster.tsx` | Per-message member × chunk grid, per-group progress |
| `client/android` | Capacitor shell: `FLAG_SECURE`, backups off, App Links for `/join/…` |
| `server/src/app.ts` | Accounts, prekey directory, groups, store-and-forward relay, origin and device policies |
| `server/src/pages.ts` | The only pages served: the invite landing page, a home page and `assetlinks.json` |

**Encryption.** Each phone generates its Signal identity locally, and the
private keys never leave it. A group message is encrypted separately for each
member over that pair's own Double Ratchet session (the way Signal handled
groups before sender keys). Read receipts are ordinary encrypted messages too.

**Reading.** Messages are split every 4 words (`WORDS_PER_CHUNK`). The text is
painted on a `<canvas>` only while the chunk is held, so the plaintext is never
in the page's DOM. A window of about 4 characters sweeps across the chunk. The
chunk counts as read only after the window has covered all of it.

**Inviting.** The Invite button shares a link,
`https://veil-secure-chat.fly.dev/join/<code>`, through the Android share sheet.
On a phone with Veil installed the link opens the app, which asks
"Join <group>?". Anyone with the link can join, so share it only with people
you want in the group.

**Verification.** Members → Verify shows a 60-digit safety number. If two
people's numbers match, nobody is in the middle. When a member's key changes,
the app flags it.

## What the server can and cannot see

The server sees accounts (email and display name), group names and membership,
public keys, and who sent an encrypted envelope to whom, when, and how big it
was. It never sees message text, which chunks anyone read, or read times.
Envelopes are deleted once the recipient acknowledges them.

## Known limits

- **Screenshots.** `FLAG_SECURE` stops screenshots, recordings and casting.
  It can't stop a rooted phone or a camera pointed at the screen. The sliding
  window limits what any single photo or video frame shows.
- **iOS.** There's no iOS app yet. It would need its own shell that hides
  content while the screen is being captured (`UIScreen.isCaptured`).
- **Account takeover.** One device per account makes a takeover visible, but
  doesn't prevent it. Use a strong, unique password.
- **No signed-prekey rotation** and no sender keys yet. Fan-out cost grows
  with group size.
- **Accessibility.** Screen readers can't read hidden chunks. That's
  inherent to the design.

## License

GPL-3.0-only. See [LICENSE](LICENSE). It has to be GPL because the Signal
implementation it uses, `@privacyresearch/libsignal-protocol-typescript`, is
GPL-3.0.
