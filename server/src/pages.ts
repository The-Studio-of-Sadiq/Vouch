// Veil has no browser version. The server serves only these tiny pages:
// the Android App Links file and a landing page for invite links opened
// on a device without the app installed.

// SHA-256 of the release signing certificate. Must match the key that signs
// the APK, or Android won't open invite links in the app.
const RELEASE_CERT_SHA256 =
  '76:0C:E5:4B:F2:8A:B7:7A:CD:7E:C2:CB:51:58:FF:A5:7E:FA:AA:0B:28:53:3A:AE:20:37:3C:56:0E:13:CA:04';

export const ASSET_LINKS = JSON.stringify([
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: 'app.veil.chat', sha256_cert_fingerprints: [RELEASE_CERT_SHA256] },
  },
]);

export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f4f6; --card: #fff; --text: #1c1d21; --muted: #6a6d78; --accent: #5b5bd6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1c20; --card: #24262b; --text: #e8e9ed; --muted: #979aa5; --accent: #7c7cf0; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
         background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  main { max-width: 380px; background: var(--card); border-radius: 14px; padding: 28px; }
  h1 { margin: 0 0 8px; font-size: 22px; } .logo { color: var(--accent); font-size: 28px; }
  p { margin: 10px 0 0; } .muted { color: var(--muted); font-size: 14px; }
</style>
</head>
<body><main><div class="logo" aria-hidden="true">◈</div>${body}</main></body>
</html>`;
}

export const HOME_PAGE = page(
  'Veil',
  `<h1>Veil</h1>
  <p>End-to-end encrypted group chat. Veil runs only as an Android app; there is no browser version.</p>`,
);

export const INVITE_PAGE = page(
  'Veil invite',
  `<h1>You've been invited to a Veil group</h1>
  <p>Open this link on an Android phone that has the Veil app installed, and the app will ask you to join.</p>
  <p>Don't have Veil? Ask the person who invited you to send you the app, install it, then open the link again.</p>
  <p class="muted">Veil runs only as an Android app. There is no browser version, by design.</p>`,
);
