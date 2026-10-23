import type { CapacitorConfig } from '@capacitor/cli';

// Dev builds talk to a plain-HTTP server (e.g. http://10.0.2.2:8787 from the
// emulator); release builds must use HTTPS and leave this off.
const devHttp = process.env.CAP_DEV_HTTP === '1';

const config: CapacitorConfig = {
  appId: 'app.veil.chat',
  appName: 'Veil',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  android: {
    allowMixedContent: devHttp,
    webContentsDebuggingEnabled: devHttp,
  },
};

export default config;
