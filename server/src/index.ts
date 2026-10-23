import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(process.env.DB_PATH ?? resolve(here, '../data/chat.db'));
mkdirSync(dirname(dbPath), { recursive: true });

const server = createServer({
  dbPath,
  port: Number(process.env.PORT ?? 8787),
  staticDir: resolve(here, '../../client/dist'),
});

server.listen().then((port) => console.log(`secure-chat server on http://localhost:${port}`));
