import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { PORT } from './config.js';
import { registerUi } from './routes/ui.js';
import { registerOAuth } from './routes/oauth.js';
import { registerAccounts } from './routes/accounts.js';
import { registerProxy } from './proxy.js';
import { refreshDueTokens, scheduleNextRefresh } from './refresh.js';

const app = new Hono();

registerUi(app);
registerOAuth(app);
registerAccounts(app);
registerProxy(app);

serve({ fetch: app.fetch, port: PORT });
console.log(`Codex Equilibrium Node server listening on http://localhost:${PORT}`);

// Background refresh loop: refresh tokens close to expiry, with jitter
refreshDueTokens();
scheduleNextRefresh();
