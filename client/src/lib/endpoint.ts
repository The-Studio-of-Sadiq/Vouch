// Where the API and relay live. The web build is served by the server itself,
// so same-origin works. The Android build loads its UI from inside the APK and
// must be pointed at the server at build time with VITE_SERVER_URL.
const configured = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/+$/, '');

export const API_BASE = configured ?? '';

export const WS_URL = configured
  ? configured.replace(/^http/, 'ws') + '/ws'
  : typeof location === 'undefined'
    ? '' // not in a browser (tests pass their own URLs)
    : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
