import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { getServices } from './services.js';

const port = Number(process.env.API_PORT ?? 8787);
const svc = await getServices(); // migrate + seed dev identity
const app = createApp();

serve({ fetch: app.fetch, port });
// Validation ops: which backends are actually serving this process.
console.log(
  `bhasya-api listening on :${port} ` +
  `db=${process.env.DATABASE_URL ? 'postgres' : 'pglite'} ` +
  `model=${svc.router.adapterId}`,
);
