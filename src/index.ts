import { Hono } from 'hono';
import { html } from 'hono/html';
import { serve } from '@hono/node-server';
import { promises as fs } from 'fs';
import path from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';

// Server config
const PORT = 1455;

// OAuth/OpenAI constants (aligned with internal/auth/codex)
const OPENAI_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;

// ChatGPT Codex backend
const CHATGPT_ENDPOINT = 'https://chatgpt.com/backend-api/codex';

// Cookie names
const COOKIE_STATE = 'oauth_state';
const COOKIE_VERIFIER = 'oauth_verifier';

// Storage paths
const AUTH_DIR = path.join(process.cwd(), 'auths');
const TOKENS_FILE = path.join(AUTH_DIR, 'codex_tokens.json');
const RR_INDEX_FILE = path.join(AUTH_DIR, 'rr-index');

type TokenRecord = {
  id: string;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  email?: string;
  expire?: string;
  created_at?: string;
  last_refresh?: string;
  // health/meta
  disabled?: boolean;
  cooldown_until?: string;
  fail_count?: number;
  last_error_code?: number;
  last_used?: string;
};

const app = new Hono();

async function ensureAuthDir() {
  try {
    await fs.mkdir(AUTH_DIR, { recursive: true });
  } catch {}
}

// Simple async mutex for file operations
class Mutex {
  private q: Promise<void> = Promise.resolve();
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.q.then(fn);
    this.q = run.then(() => undefined, () => undefined);
    return run;
  }
}
const tokenMutex = new Mutex();
const rrMutex = new Mutex();

async function atomicWrite(filePath: string, content: string) {
  await ensureAuthDir();
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

function maskToken(token: string) {
  if (!token || token.length < 10) return token;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

async function readTokens(): Promise<TokenRecord[]> {
  return tokenMutex.lock(async () => {
    await ensureAuthDir();
    try {
      const data = await fs.readFile(TOKENS_FILE, 'utf8');
      return JSON.parse(data);
    } catch {
      return [] as TokenRecord[];
    }
  });
}

async function writeTokens(tokens: TokenRecord[]) {
  await tokenMutex.lock(async () => {
    await ensureAuthDir();
    await atomicWrite(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  });
}

async function readRR(): Promise<number> {
  return rrMutex.lock(async () => {
    try {
      return parseInt(await fs.readFile(RR_INDEX_FILE, 'utf8'), 10) || 0;
    } catch {
      return 0;
    }
  });
}

async function writeRR(v: number) {
  await rrMutex.lock(async () => {
    await atomicWrite(RR_INDEX_FILE, String(v));
  });
}

function isCoolingDown(rec: TokenRecord): boolean {
  if (!rec.cooldown_until) return false;
  const t = Date.parse(rec.cooldown_until);
  return !Number.isNaN(t) && t > Date.now();
}

function isExpired(rec: TokenRecord): boolean {
  if (!rec.expire) return false;
  const t = Date.parse(rec.expire);
  return Number.isNaN(t) ? false : t <= Date.now();
}

async function selectNextToken(): Promise<{ rec: TokenRecord | undefined; index: number; total: number }> {
  const tokens = await readTokens();
  const total = tokens.length;
  if (total === 0) return { rec: undefined, index: 0, total };
  const start = await readRR();
  for (let i = 0; i < total; i++) {
    const idx = (start + i) % total;
    const t = tokens[idx];
    if (t.disabled) continue;
    if (isCoolingDown(t)) continue;
    if (isExpired(t)) continue;
    // Found candidate
    await writeRR((idx + 1) % total);
    t.last_used = new Date().toISOString();
    await updateRecord(t);
    return { rec: t, index: idx, total };
  }
  // If none suitable, still advance rr to avoid stickiness
  await writeRR((start + 1) % total);
  return { rec: undefined, index: start % total, total };
}

function b64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generateCodeVerifier(): string {
  // 96 random bytes -> 128 base64url chars (matches internal)
  return randomBytes(96).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  const digest = createHash('sha256').update(verifier).digest();
  return b64url(digest);
}

function randomState(): string {
  return randomBytes(24).toString('base64url');
}

function setCookie(c: any, name: string, value: string) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  // Running locally; add Secure only if https
  const url = new URL(c.req.url);
  if (url.protocol === 'https:') attrs.push('Secure');
  c.header('Set-Cookie', attrs.join('; '), { append: true });
}

function getCookie(c: any, name: string): string | undefined {
  const cookie = c.req.header('Cookie') || '';
  const parts = cookie.split(/;\s*/);
  for (const p of parts) {
    const [k, ...rest] = p.split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function decodeJwtPayload(idToken?: string): {
  email?: string;
  account_id?: string;
} {
  if (!idToken) return {};
  const parts = idToken.split('.');
  if (parts.length !== 3) return {};
  try {
    let payload = parts[1];
    const pad = payload.length % 4;
    if (pad === 2) payload += '==';
    if (pad === 3) payload += '=';
    const json = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    const obj = JSON.parse(json);
    const email = obj?.email;
    const accountId =
      obj?.['https://api.openai.com/auth']?.['chatgpt_account_id'];
    return { email, account_id: accountId };
  } catch {
    return {};
  }
}

function parseExpireSeconds(expires_in?: any): string | undefined {
  const n = Number(expires_in);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(Date.now() + n * 1000).toISOString();
}

function isNearExpiry(expire?: string, thresholdMs = 10 * 60 * 1000): boolean {
  if (!expire) return true;
  const t = Date.parse(expire);
  if (Number.isNaN(t)) return true;
  return t - Date.now() <= thresholdMs;
}

async function updateRecord(updated: TokenRecord) {
  const list = await readTokens();
  const idx = list.findIndex((t) => t.id === updated.id);
  if (idx >= 0) {
    list[idx] = updated;
    await writeTokens(list);
  }
}

async function removeRecord(id: string) {
  const list = await readTokens();
  const next = list.filter((t) => t.id !== id);
  await writeTokens(next);
}

const refreshing = new Set<string>();

async function refreshToken(
  rec: TokenRecord
): Promise<TokenRecord | undefined> {
  if (!rec.refresh_token) return undefined;
  if (refreshing.has(rec.id)) return undefined;
  refreshing.add(rec.id);
  try {
    const body = new URLSearchParams({
      client_id: OPENAI_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: rec.refresh_token,
      scope: 'openid profile email',
    });
    const resp = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!resp.ok) {
      // mark failure + cooldown
      const code = resp.status;
      const updatedFail: TokenRecord = {
        ...rec,
        last_error_code: code,
        fail_count: (rec.fail_count || 0) + 1,
      };
      let cooldownMs = 0;
      if (code === 429) cooldownMs = 30 * 60 * 1000;
      else if (code === 401 || code === 403) cooldownMs = 10 * 60 * 1000;
      else if (code === 408 || code === 500 || code === 502 || code === 503 || code === 504) {
        const fc = updatedFail.fail_count || 1;
        cooldownMs = Math.min(30 * 60 * 1000, (1 << Math.min(fc, 5)) * 60 * 1000);
      }
      if (cooldownMs > 0) updatedFail.cooldown_until = new Date(Date.now() + cooldownMs).toISOString();
      await updateRecord(updatedFail);
      return undefined;
    }
    const json: any = await resp.json();
    const { access_token, refresh_token, id_token, expires_in } = json;
    const meta = decodeJwtPayload(id_token);
    const updated: TokenRecord = {
      ...rec,
      access_token: access_token ?? rec.access_token,
      refresh_token: refresh_token ?? rec.refresh_token,
      id_token: id_token ?? rec.id_token,
      account_id: meta.account_id ?? rec.account_id,
      email: meta.email ?? rec.email,
      expire: parseExpireSeconds(expires_in) ?? rec.expire,
      last_refresh: new Date().toISOString(),
      fail_count: 0,
      last_error_code: undefined,
      cooldown_until: undefined,
    };
    await updateRecord(updated);
    return updated;
  } finally {
    refreshing.delete(rec.id);
  }
}

function computeCooldownMs(code: number, failCount: number): number {
  if (code === 429) return 30 * 60 * 1000;
  if (code === 401 || code === 403) return 10 * 60 * 1000;
  if (code === 408 || code === 500 || code === 502 || code === 503 || code === 504) {
    return Math.min(30 * 60 * 1000, (1 << Math.min(failCount, 5)) * 60 * 1000);
  }
  return 0;
}

async function markFailure(rec: TokenRecord, code: number) {
  const fc = (rec.fail_count || 0) + 1;
  const cooldownMs = computeCooldownMs(code, fc);
  const updated: TokenRecord = {
    ...rec,
    fail_count: fc,
    last_error_code: code,
    cooldown_until: cooldownMs > 0 ? new Date(Date.now() + cooldownMs).toISOString() : rec.cooldown_until,
  };
  await updateRecord(updated);
}

app.get('/', async (c) => {
  return c.html(html`<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Codex Equilibrium</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto,
              Oxygen, Ubuntu, Cantarell, sans-serif;
            margin: 2rem;
          }
          a.button {
            display: inline-block;
            margin: 0.5rem 0.5rem 1rem 0;
            padding: 0.5rem 1rem;
            background: #4f46e5;
            color: white;
            border-radius: 4px;
            text-decoration: none;
          }
          button {
            cursor: pointer;
          }
          table {
            border-collapse: collapse;
            width: 100%;
            margin-top: 1rem;
          }
          th,
          td {
            border: 1px solid #e5e7eb;
            padding: 8px 10px;
            text-align: left;
          }
          th {
            background: #f9fafb;
          }
          .muted {
            color: #6b7280;
          }
          .status.active {
            color: #10b981;
          }
          .status.expiring-soon {
            color: #f59e0b;
          }
          .status.expired {
            color: #ef4444;
          }
          .actions button {
            margin-right: 8px;
            padding: 4px 10px;
            border-radius: 4px;
            border: 1px solid #d1d5db;
            background: #f3f4f6;
          }
          .actions button:hover {
            background: #e5e7eb;
          }
        </style>
      </head>
      <body>
        <h1>Codex Equilibrium</h1>
        <div>
          <a class="button" href="/oauth/start">Add OpenAI Account</a>
          <button id="refresh-all" class="button" style="background:#059669">
            Refresh All
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Account ID</th>
              <th>Token</th>
              <th>Created</th>
              <th>Last Refresh</th>
              <th>Last Used</th>
              <th>Expire</th>
              <th>Status</th>
              <th>Cooldown</th>
              <th>Fails</th>
              <th>Last Error</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="acct-body">
            <tr>
              <td colspan="12" class="muted">Loading...</td>
            </tr>
          </tbody>
        </table>
        <script>
          async function fetchAccounts() {
            const res = await fetch('/accounts');
            const data = await res.json();
            return data.accounts || [];
          }
          function esc(s) {
            return (s || '').replace(/[&<>]/g, function (c) {
              return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
            });
          }
          async function render() {
            const tbody = document.getElementById('acct-body');
            const rows = [];
            const accounts = await fetchAccounts();
            if (accounts.length === 0) {
              tbody.innerHTML =
                '<tr><td colspan="12" class="muted">No accounts yet</td></tr>';
              return;
            }
            for (var i = 0; i < accounts.length; i++) {
              var a = accounts[i];
              rows.push(
                '<tr data-id="' +
                  esc(a.id) +
                  '">' +
                  '<td>' +
                  esc(a.email) +
                  '</td>' +
                  '<td>' +
                  esc(a.account_id) +
                  '</td>' +
                  '<td>' +
                  esc(a.token) +
                  '</td>' +
                  '<td>' +
                  esc(a.created_at || '') +
                  '</td>' +
                  '<td>' +
                  esc(a.last_refresh || '') +
                  '</td>' +
                  '<td>' +
                  esc(a.last_used || '') +
                  '</td>' +
                  '<td>' +
                  esc(a.expire || '') +
                  '</td>' +
                  '<td class="status ' +
                  esc(a.status) +
                  '">' +
                  esc(a.status) +
                  '</td>' +
                  '<td>' + esc(a.cooldown_until || '') + '</td>' +
                  '<td>' + String(a.fail_count || 0) + '</td>' +
                  '<td>' + (a.last_error_code || '') + '</td>' +
                  '<td class="actions">' +
                  '<button data-action="refresh" data-id="' +
                  esc(a.id) +
                  '">Refresh</button>' +
                  (a.disabled
                    ? '<button data-action="enable" data-id="' +
                      esc(a.id) +
                      '">Enable</button>'
                    : '<button data-action="disable" data-id="' +
                      esc(a.id) +
                      '">Disable</button>') +
                  '<button data-action="delete" data-id="' +
                  esc(a.id) +
                  '">Delete</button>' +
                  '</td>' +
                  '</tr>'
              );
            }
            tbody.innerHTML = rows.join('');
          }
          document.addEventListener('click', async function (e) {
            var t = e.target;
            if (t && t.dataset && t.dataset.action === 'delete') {
              var id = t.dataset.id;
              if (!confirm('Delete this account?')) return;
              var res = await fetch('/accounts/' + encodeURIComponent(id), {
                method: 'DELETE',
              });
              if (res.ok) await render();
            } else if (t && t.dataset && t.dataset.action === 'refresh') {
              var id2 = t.dataset.id;
              t.disabled = true;
              t.textContent = 'Refreshing...';
              var res2 = await fetch(
                '/accounts/' + encodeURIComponent(id2) + '/refresh',
                { method: 'POST' }
              );
              t.disabled = false;
              t.textContent = 'Refresh';
              if (res2.ok) await render();
            } else if (t && t.dataset && t.dataset.action === 'disable') {
              var id3 = t.dataset.id;
              t.disabled = true;
              var res3 = await fetch('/accounts/' + encodeURIComponent(id3) + '/disable', { method: 'POST' });
              t.disabled = false;
              if (res3.ok) await render();
            } else if (t && t.dataset && t.dataset.action === 'enable') {
              var id4 = t.dataset.id;
              t.disabled = true;
              var res4 = await fetch('/accounts/' + encodeURIComponent(id4) + '/enable', { method: 'POST' });
              t.disabled = false;
              if (res4.ok) await render();
            } else if (t && t.id === 'refresh-all') {
              t.disabled = true;
              t.textContent = 'Refreshing All...';
              var list = await fetchAccounts();
              for (var j = 0; j < list.length; j++) {
                await fetch(
                  '/accounts/' + encodeURIComponent(list[j].id) + '/refresh',
                  { method: 'POST' }
                );
              }
              t.disabled = false;
              t.textContent = 'Refresh All';
              await render();
            }
          });
          render();
        </script>
      </body>
    </html>`);
});

app.get('/oauth/start', async (c) => {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = randomState();
  setCookie(c, COOKIE_VERIFIER, verifier);
  setCookie(c, COOKIE_STATE, state);

  const params = new URLSearchParams({
    client_id: OPENAI_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'openid email profile offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  });
  return c.redirect(`${OPENAI_AUTH_URL}?${params.toString()}`);
});

app.get('/auth/callback', async (c) => {
  const url = new URL(c.req.url);
  const err = url.searchParams.get('error');
  if (err) return c.text(`OAuth error: ${err}`, 400);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expState = getCookie(c, COOKIE_STATE);
  const verifier = getCookie(c, COOKIE_VERIFIER);
  if (!code || !state)
    return c.text('Missing authorization code or state', 400);
  if (!expState || state !== expState) return c.text('Invalid state', 400);
  if (!verifier) return c.text('Missing PKCE verifier', 400);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OPENAI_CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const resp = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const t = await resp.text();
    return c.text(`Token exchange failed: ${resp.status} ${t}`, 500);
  }
  const json: any = await resp.json();
  const { access_token, refresh_token, id_token, expires_in } = json;
  const meta = decodeJwtPayload(id_token);
  const rec: TokenRecord = {
    id: randomUUID(),
    access_token,
    refresh_token,
    id_token,
    account_id: meta.account_id,
    email: meta.email,
    expire: parseExpireSeconds(expires_in),
    created_at: new Date().toISOString(),
    last_refresh: new Date().toISOString(),
    fail_count: 0,
    last_error_code: undefined,
    disabled: false,
  };
  const tokens = await readTokens();
  tokens.push(rec);
  await writeTokens(tokens);

  return c.html(html`<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Authentication Successful</title>
        <style>
          body {
            font-family: sans-serif;
            margin: 2rem;
            display: grid;
            place-items: center;
          }
          .card {
            max-width: 560px;
            padding: 1.5rem;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
          }
          .btn {
            display: inline-block;
            margin-top: 1rem;
            padding: 0.5rem 1rem;
            background: #4f46e5;
            color: white;
            border-radius: 4px;
            text-decoration: none;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Authentication successful</h2>
          <p>You can close this window and return to the app.</p>
          <a class="btn" href="/">Back to home</a>
        </div>
        <script>
          setTimeout(() => {
            if (window.opener) window.close();
          }, 2000);
        </script>
      </body>
    </html>`);
});

app.get('/accounts', async (c) => {
  const tokens = await readTokens();
  const accounts = tokens.map((t) => {
    let status = 'unknown';
    let expires_in_seconds: number | undefined;
    if (t.disabled) status = 'disabled';
    else if (t.cooldown_until && Date.parse(t.cooldown_until) > Date.now()) status = 'cooldown';
    else if (t.expire) {
      const tms = Date.parse(t.expire);
      if (!Number.isNaN(tms)) {
        const diff = Math.floor((tms - Date.now()) / 1000);
        expires_in_seconds = diff;
        if (diff <= 0) status = 'expired';
        else if (diff <= 5 * 60) status = 'expiring-soon';
        else status = 'active';
      }
    }
    return {
      id: t.id,
      email: t.email,
      account_id: t.account_id,
      created_at: t.created_at,
      last_refresh: t.last_refresh,
      expire: t.expire,
      expires_in_seconds,
      status,
      cooldown_until: t.cooldown_until,
      fail_count: t.fail_count || 0,
      last_error_code: t.last_error_code,
      last_used: t.last_used,
      disabled: !!t.disabled,
      token: maskToken(t.access_token),
    };
  });
  return c.json({ accounts });
});

// ===== OpenAI-compatible endpoints =====

function wantStream(payload: any): boolean {
  try {
    return !!payload?.stream;
  } catch {
    return false;
  }
}

async function forwardResponses(c: any, payload: any) {
  const url = `${CHATGPT_ENDPOINT}/responses`;
  const stream = wantStream(payload);
  const body = JSON.stringify(payload);

  const tryOnce = async (token: TokenRecord) => {
    const upstreamHeaders = new Headers(c.req.raw.headers);
    upstreamHeaders.set('Authorization', `Bearer ${token.access_token}`);
    upstreamHeaders.set('Openai-Beta', 'responses=experimental');
    upstreamHeaders.set('Content-Type', 'application/json');
    upstreamHeaders.set('Version', '0.21.0');
    upstreamHeaders.set('Session_id', randomUUID());
    if (token.account_id)
      upstreamHeaders.set('Chatgpt-Account-Id', token.account_id);
    upstreamHeaders.set('Originator', 'codex_cli_rs');
    upstreamHeaders.set('Accept', stream ? 'text/event-stream' : 'application/json');
    return fetch(url, { method: 'POST', headers: upstreamHeaders, body });
  };

  const { rec: first, total } = await selectNextToken();
  if (!first) return c.json({ error: 'No usable accounts (all disabled, cooling down or expired)' }, 503);

  // Try across up to all tokens
  const maxAttempts = Math.min(total, 3) || 1;
  let current = first;
  let resp = await tryOnce(current);
  // 401/403: try one refresh
  if (resp.status === 401 || resp.status === 403) {
    const refreshed = await refreshToken(current);
    if (refreshed) {
      current = refreshed;
      resp = await tryOnce(current);
    }
  }
  const retriable = (code: number) => code === 429 || code === 403 || code === 408 || code === 500 || code === 502 || code === 503 || code === 504;
  let attempts = 1;
  while (attempts < maxAttempts && retriable(resp.status)) {
    // mark failure and cooldown for current
    await markFailure(current, resp.status);
    const sel = await selectNextToken();
    if (!sel.rec) break;
    current = sel.rec;
    resp = await tryOnce(current);
    attempts++;
  }

  if (stream) {
    const headers = new Headers(resp.headers);
    headers.set('Cache-Control', 'no-cache');
    headers.set('Connection', 'keep-alive');
    if (!headers.get('Content-Type')?.includes('text/event-stream')) {
      headers.set('Content-Type', 'text/event-stream');
    }
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
  }
  const headers = new Headers(resp.headers);
  if (!headers.get('Content-Type')?.includes('application/json')) {
    headers.set('Content-Type', 'application/json');
  }
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

// POST /v1/responses (stream and non-stream)
app.post('/v1/responses', async (c) => {
  const payload = await c.req.json();
  // Direct Responses passthrough (no OpenAI conversion)
  return forwardResponses(c, payload);
});

// GET /v1/models - static minimal list
app.get('/v1/models', async (c) => {
  return c.json({
    object: 'list',
    data: [
      { id: 'gpt-5', object: 'model' },
      { id: 'gpt-5-minimal', object: 'model' },
      { id: 'gpt-5-low', object: 'model' },
      { id: 'gpt-5-medium', object: 'model' },
      { id: 'gpt-5-high', object: 'model' },
      { id: 'codex-mini-latest', object: 'model' },
    ],
  });
});

// Minimal converter: chat.completions -> responses
function shortenNameIfNeeded(name: string): string {
  const limit = 64;
  if (name.length <= limit) return name;
  if (name.startsWith('mcp__')) {
    const idx = name.lastIndexOf('__');
    if (idx > 0) {
      let candidate = 'mcp__' + name.slice(idx + 2);
      if (candidate.length > limit) candidate = candidate.slice(0, limit);
      return candidate;
    }
  }
  return name.slice(0, limit);
}

function buildShortNameMap(names: string[]): Record<string, string> {
  const limit = 64;
  const used: Record<string, boolean> = {};
  const map: Record<string, string> = {};
  const baseCandidate = (n: string) => {
    if (n.length <= limit) return n;
    if (n.startsWith('mcp__')) {
      const idx = n.lastIndexOf('__');
      if (idx > 0) {
        let cand = 'mcp__' + n.slice(idx + 2);
        if (cand.length > limit) cand = cand.slice(0, limit);
        return cand;
      }
    }
    return n.slice(0, limit);
  };
  const makeUnique = (cand: string) => {
    if (!used[cand]) return cand;
    const base = cand;
    for (let i = 1; ; i++) {
      const suffix = '~' + i;
      const allowed = Math.max(0, limit - suffix.length);
      let tmp = base;
      if (tmp.length > allowed) tmp = tmp.slice(0, allowed);
      tmp = tmp + suffix;
      if (!used[tmp]) return tmp;
    }
  };
  for (const n of names) {
    const cand = baseCandidate(n);
    const uniq = makeUnique(cand);
    used[uniq] = true;
    map[n] = uniq;
  }
  return map;
}

function convertChatCompletionsToResponses(payload: any) {
  const out: any = {};
  const stream = !!payload?.stream;
  out.stream = stream;

  // Model + reasoning
  let model = payload?.model ?? 'gpt-5';
  let reasoningEffort = payload?.reasoning_effort ?? 'low';
  if (
    model === 'gpt-5-minimal' ||
    model === 'gpt-5-low' ||
    model === 'gpt-5-medium' ||
    model === 'gpt-5-high'
  ) {
    const mapEffort: Record<string, string> = {
      'gpt-5-minimal': 'minimal',
      'gpt-5-low': 'low',
      'gpt-5-medium': 'medium',
      'gpt-5-high': 'high',
    };
    reasoningEffort = mapEffort[model] || reasoningEffort;
    model = 'gpt-5';
  }
  out.model = model;
  out.reasoning = { effort: reasoningEffort };
  out.parallel_tool_calls = true;
  out.reasoning = { ...(out.reasoning || {}), summary: 'auto' };
  out.include = ['reasoning.encrypted_content'];

  // response_format -> text.format
  const rf = payload?.response_format;
  const text = payload?.text;
  let store = false;
  if (rf && typeof rf === 'object') {
    out.text = out.text || {};
    const rft = rf.type;
    if (rft === 'text') {
      out.text.format = { type: 'text' };
    } else if (rft === 'json_schema') {
      const js = rf.json_schema || {};
      out.text.format = {
        type: 'json_schema',
        name: js.name,
        strict: js.strict,
        schema: js.schema,
      };
    }
    // verbosity if provided
    if (text && typeof text === 'object' && text.verbosity !== undefined) {
      out.text.verbosity = text.verbosity;
    }
    store = true;
  } else if (text && typeof text === 'object' && text.verbosity !== undefined) {
    out.text = out.text || {};
    out.text.verbosity = text.verbosity;
  }

  // Tools mapping (flatten function fields)
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  let originalToolNameMap: Record<string, string> = {};
  if (tools.length > 0) {
    const names: string[] = [];
    for (const t of tools) {
      if (t?.type === 'function' && t.function?.name) names.push(t.function.name);
    }
    if (names.length > 0) originalToolNameMap = buildShortNameMap(names);
    out.tools = [];
    for (const t of tools) {
      if (t?.type === 'function') {
        const fn = t.function || {};
        let name = fn.name || '';
        if (originalToolNameMap[name]) name = originalToolNameMap[name];
        else name = shortenNameIfNeeded(name);
        const item: any = { type: 'function', name };
        if (fn.description !== undefined) item.description = fn.description;
        if (fn.parameters !== undefined) item.parameters = fn.parameters;
        if (fn.strict !== undefined) item.strict = fn.strict;
        out.tools.push(item);
      }
    }
  }

  // Instructions from system message (string or text content)
  let instructions = 'You are a helpful assistant.';
  const msgs: any[] = Array.isArray(payload?.messages) ? payload.messages : [];
  for (const m of msgs) {
    if (m?.role === 'system') {
      const c = m?.content;
      if (typeof c === 'string' && c) {
        instructions = c;
        break;
      }
      if (Array.isArray(c)) {
        const t = c.find((x: any) => x?.type === 'text' && x?.text);
        if (t?.text) {
          instructions = t.text;
          break;
        }
      }
    }
  }
  out.instructions = instructions;

  // Build input array from messages
  const input: any[] = [];
  for (const m of msgs) {
    const role = m?.role;
    if (role === 'tool') {
      // tool message → function_call_output
      input.push({
        type: 'function_call_output',
        call_id: m?.tool_call_id ?? '',
        output: typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''),
      });
      continue;
    }
    const msg: any = { type: 'message', role: role === 'system' ? 'user' : role, content: [] as any[] };
    const c = m?.content;
    if (typeof c === 'string') {
      msg.content.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: c });
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === 'text' && part?.text) {
          msg.content.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text });
        } else if (part?.type === 'image_url' && role === 'user') {
          const u = part?.image_url?.url;
          if (u) msg.content.push({ type: 'input_image', image_url: u });
        }
      }
    }
    input.push(msg);

    // assistant tool_calls → separate function_call objects
    if (role === 'assistant' && Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.type === 'function') {
          let name = tc.function?.name || '';
          if (originalToolNameMap[name]) name = originalToolNameMap[name];
          else name = shortenNameIfNeeded(name);
          input.push({
            type: 'function_call',
            call_id: tc.id || '',
            name,
            arguments: tc.function?.arguments || '',
          });
        }
      }
    }
  }
  out.input = input;

  // Decide store
  out.store = store;
  return out;
}

// POST /v1/chat/completions
function buildReverseMapFromOpenAI(original: any): Record<string, string> {
  const tools = Array.isArray(original?.tools) ? original.tools : [];
  const names: string[] = [];
  for (const t of tools) {
    if (t?.type === 'function' && t.function?.name) names.push(t.function.name);
  }
  if (names.length === 0) return {};
  const short = buildShortNameMap(names);
  const rev: Record<string, string> = {};
  for (const orig of Object.keys(short)) rev[short[orig]] = orig;
  return rev;
}

// Streaming mapping: Responses SSE -> OpenAI Chat chunk SSE
function mapResponsesEventToChatChunk(evt: any, state: any, revMap: Record<string, string>): string | undefined {
  if (!state.inited && evt?.type === 'response.created') {
    state.inited = true;
    state.response_id = evt?.response?.id || '';
    state.created_at = evt?.response?.created_at || Date.now() / 1000 | 0;
    state.model = evt?.response?.model || state.model || 'gpt-5';
    return undefined;
  }
  const base = {
    id: state.response_id || '',
    object: 'chat.completion.chunk',
    created: state.created_at || (Date.now() / 1000 | 0),
    model: state.model || 'gpt-5',
    choices: [ {
      index: 0,
      delta: { role: 'assistant' as any },
      finish_reason: null as any,
      native_finish_reason: null as any,
    } ],
  } as any;

  switch (evt?.type) {
    case 'response.reasoning_summary_text.delta': {
      base.choices[0].delta.reasoning_content = evt?.delta || '';
      return JSON.stringify(base);
    }
    case 'response.reasoning_summary_text.done': {
      base.choices[0].delta.reasoning_content = '\n\n';
      return JSON.stringify(base);
    }
    case 'response.output_text.delta': {
      base.choices[0].delta.content = evt?.delta || '';
      return JSON.stringify(base);
    }
    case 'response.output_item.done': {
      const item = evt?.item;
      if (item?.type !== 'function_call') return undefined;
      state.fnIdx = (state.fnIdx ?? -1) + 1;
      const nameShort = item?.name || '';
      const name = revMap[nameShort] || nameShort;
      base.choices[0].delta.tool_calls = [ {
        index: state.fnIdx,
        id: item?.call_id || '',
        type: 'function',
        function: { name, arguments: item?.arguments || '' },
      } ];
      return JSON.stringify(base);
    }
    case 'response.completed': {
      const fr = (state.fnIdx != null && state.fnIdx >= 0) ? 'tool_calls' : 'stop';
      base.choices[0].finish_reason = fr;
      base.choices[0].native_finish_reason = fr;
      return JSON.stringify(base);
    }
    default:
      return undefined;
  }
}

// Non-stream mapping: Responses SSE blob -> OpenAI Chat JSON
function convertResponsesBlobToChat(originalOpenAI: any, blob: string): string {
  const rev = buildReverseMapFromOpenAI(originalOpenAI);
  const lines = blob.split(/\r?\n/);
  let completed: any;
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    let obj; try { obj = JSON.parse(line.slice(6)); } catch { continue; }
    if (obj?.type === 'response.completed') { completed = obj; break; }
  }
  if (!completed) return JSON.stringify({ error: 'invalid_upstream_response' });
  const resp = completed.response || {};
  const template: any = {
    id: resp.id || '',
    object: 'chat.completion',
    created: resp.created_at || (Date.now()/1000|0),
    model: resp.model || 'gpt-5',
    choices: [ { index: 0, message: { role: 'assistant' as any }, finish_reason: null, native_finish_reason: null } ],
  };
  const usage = resp.usage || {};
  if (usage) {
    template.usage = {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
      completion_tokens_details: { reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens }
    };
  }
  let contentText = '';
  let reasoningText = '';
  const toolCalls: any[] = [];
  const outArr = Array.isArray(resp.output) ? resp.output : [];
  for (const it of outArr) {
    if (it?.type === 'reasoning' && Array.isArray(it?.summary)) {
      for (const sum of it.summary) {
        if (sum?.type === 'summary_text' && sum?.text) { reasoningText = sum.text; break; }
      }
    } else if (it?.type === 'message' && Array.isArray(it?.content)) {
      for (const part of it.content) {
        if (part?.type === 'output_text' && part?.text) { contentText = part.text; break; }
      }
    } else if (it?.type === 'function_call') {
      const nameShort = it?.name || '';
      const name = rev[nameShort] || nameShort;
      toolCalls.push({ id: it?.call_id || '', type: 'function', function: { name, arguments: it?.arguments || '' } });
    }
  }
  if (contentText) template.choices[0].message.content = contentText, template.choices[0].message.role = 'assistant';
  if (reasoningText) template.choices[0].message.reasoning_content = reasoningText, template.choices[0].message.role = 'assistant';
  if (toolCalls.length) template.choices[0].message.tool_calls = toolCalls, template.choices[0].finish_reason = 'tool_calls', template.choices[0].native_finish_reason = 'tool_calls';
  else template.choices[0].finish_reason = 'stop', template.choices[0].native_finish_reason = 'stop';
  return JSON.stringify(template);
}

// Convert Chat -> Completions (non-stream)
function convertChatToCompletions(chatJSON: string): string {
  let root: any; try { root = JSON.parse(chatJSON); } catch { return chatJSON; }
  const out: any = { id: root.id, object: 'text_completion', created: root.created, model: root.model, choices: [] };
  const usage = root.usage; if (usage) out.usage = usage;
  const msg = root?.choices?.[0]?.message;
  const text = msg?.content || '';
  out.choices.push({ index: 0, text, finish_reason: root?.choices?.[0]?.finish_reason, logprobs: null });
  return JSON.stringify(out);
}

// Convert Chat Chunk -> Completions Chunk (stream)
function convertChatChunkToCompletionsChunk(chunkJSON: string): string | undefined {
  let root: any; try { root = JSON.parse(chunkJSON); } catch { return undefined; }
  const text = root?.choices?.[0]?.delta?.content;
  const finish = root?.choices?.[0]?.finish_reason ?? null;
  const out: any = { id: root.id, object: 'text_completion', created: root.created, model: root.model, choices: [ { index: 0, text: text ?? '', finish_reason: finish } ] };
  if (root.usage) out.usage = root.usage;
  return JSON.stringify(out);
}

// Robust streaming fetch to Responses endpoint with retry/switch logic
async function robustResponsesStreamFetch(c: any, bodyString: string): Promise<Response | undefined> {
  const url = `${CHATGPT_ENDPOINT}/responses`;
  const { rec: first, total } = await selectNextToken();
  if (!first) return undefined;
  const maxAttempts = Math.min(total, 3) || 1;

  const tryOnce = async (token: TokenRecord) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set('Authorization', `Bearer ${token.access_token}`);
    headers.set('Openai-Beta', 'responses=experimental');
    headers.set('Content-Type', 'application/json');
    headers.set('Version', '0.21.0');
    headers.set('Session_id', randomUUID());
    if (token.account_id) headers.set('Chatgpt-Account-Id', token.account_id);
    headers.set('Originator', 'codex_cli_rs');
    headers.set('Accept', 'text/event-stream');
    return fetch(url, { method: 'POST', headers, body: bodyString });
  };

  let current = first;
  let resp = await tryOnce(current);
  if (resp.status === 401 || resp.status === 403) {
    const refreshed = await refreshToken(current);
    if (refreshed) {
      current = refreshed;
      resp = await tryOnce(current);
    }
  }
  const retriable = (code: number) => code === 429 || code === 403 || code === 408 || code === 500 || code === 502 || code === 503 || code === 504;
  let attempts = 1;
  while (attempts < maxAttempts && retriable(resp.status)) {
    await markFailure(current, resp.status);
    const sel = await selectNextToken();
    if (!sel.rec) break;
    current = sel.rec;
    resp = await tryOnce(current);
    attempts++;
  }
  return resp;
}

app.post('/v1/chat/completions', async (c) => {
  const original = await c.req.json();
  const converted = convertChatCompletionsToResponses(original);
  const stream = !!original?.stream;

  if (stream) {
    // Streaming: robust upstream fetch with retries/switching; then map SSE lines to Chat chunks
    const resp = await robustResponsesStreamFetch(c, JSON.stringify(converted));
    if (!resp) return c.json({ error: 'No usable accounts (all disabled, cooling down or expired)' }, 503);
    if (!(resp.status >= 200 && resp.status < 300)) {
      // Forward as-is on non-2xx
      return resp;
    }
    const rev = buildReverseMapFromOpenAI(original);
    const state: any = { model: original?.model };
    const reader = (resp.body as any).getReader();
    const enc = new TextDecoder();
    const streamOut = new ReadableStream({
      async start(controller) {
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += enc.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
            if (line.startsWith('data: ')) {
              let obj; try { obj = JSON.parse(line.slice(6)); } catch { obj = undefined; }
              if (obj) {
                const mapped = mapResponsesEventToChatChunk(obj, state, rev);
                if (mapped) {
                  const s = 'data: ' + mapped + '\n\n';
                  controller.enqueue(new TextEncoder().encode(s));
                }
              }
            }
          }
        }
        controller.close();
      }
    });
    const outHeaders = new Headers(resp.headers);
    outHeaders.set('Content-Type', 'text/event-stream');
    outHeaders.set('Cache-Control', 'no-cache');
    outHeaders.set('Connection', 'keep-alive');
    return new Response(streamOut, { status: resp.status, headers: outHeaders });
  } else {
    // Non-stream: convert final SSE blob to OpenAI Chat JSON
    const res = await forwardResponses(c, converted);
    const text = await (res as any).text();
    const chat = convertResponsesBlobToChat(original, text);
    return new Response(chat, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
});

// POST /v1/completions -> convert to chat completions then to responses
app.post('/v1/completions', async (c) => {
  const p = await c.req.json();
  const prompt = p?.prompt ?? '';
  const originalChat = {
    model: p?.model ?? 'gpt-5',
    stream: !!p?.stream,
    messages: [ { role: 'user', content: String(prompt) } ],
  };
  const converted = convertChatCompletionsToResponses(originalChat);
  const stream = !!originalChat.stream;

  if (stream) {
    // Produce Completions streaming by mapping Chat chunks to completions chunks with robust upstream
    const resp = await robustResponsesStreamFetch(c, JSON.stringify(converted));
    if (!resp) return c.json({ error: 'No usable accounts (all disabled, cooling down or expired)' }, 503);
    if (!(resp.status >= 200 && resp.status < 300)) {
      return resp;
    }
    const rev = buildReverseMapFromOpenAI(originalChat);
    const state: any = { model: originalChat?.model };
    const reader = (resp.body as any).getReader();
    const enc = new TextDecoder();
    const streamOut = new ReadableStream({
      async start(controller) {
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += enc.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
            if (line.startsWith('data: ')) {
              let obj; try { obj = JSON.parse(line.slice(6)); } catch { obj = undefined; }
              if (obj) {
                const chatChunk = mapResponsesEventToChatChunk(obj, state, rev);
                if (chatChunk) {
                  const comp = convertChatChunkToCompletionsChunk(chatChunk);
                  if (comp) {
                    const s = 'data: ' + comp + '\n\n';
                    controller.enqueue(new TextEncoder().encode(s));
                  }
                }
              }
            }
          }
        }
        controller.close();
      }
    });
    const outHeaders = new Headers(resp.headers);
    outHeaders.set('Content-Type', 'text/event-stream');
    outHeaders.set('Cache-Control', 'no-cache');
    outHeaders.set('Connection', 'keep-alive');
    return new Response(streamOut, { status: resp.status, headers: outHeaders });
  } else {
    const res = await forwardResponses(c, converted);
    const text = await (res as any).text();
    const chat = convertResponsesBlobToChat(originalChat, text);
    const comp = convertChatToCompletions(chat);
    return new Response(comp, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
});

// Management: delete an account by id
app.delete('/accounts/:id', async (c) => {
  const id = c.req.param('id');
  await removeRecord(id);
  return c.json({ ok: true });
});

// Management: force refresh a token
app.post('/accounts/:id/refresh', async (c) => {
  const id = c.req.param('id');
  const tokens = await readTokens();
  const rec = tokens.find((t) => t.id === id);
  if (!rec) return c.json({ error: 'not found' }, 404);
  const updated = await refreshToken(rec);
  if (!updated) return c.json({ error: 'refresh_failed' }, 500);
  return c.json({ ok: true, id: updated.id, expire: updated.expire });
});

// Management: disable/enable
app.post('/accounts/:id/disable', async (c) => {
  const id = c.req.param('id');
  const tokens = await readTokens();
  const rec = tokens.find((t) => t.id === id);
  if (!rec) return c.json({ error: 'not found' }, 404);
  rec.disabled = true;
  await updateRecord(rec);
  return c.json({ ok: true });
});

app.post('/accounts/:id/enable', async (c) => {
  const id = c.req.param('id');
  const tokens = await readTokens();
  const rec = tokens.find((t) => t.id === id);
  if (!rec) return c.json({ error: 'not found' }, 404);
  rec.disabled = false;
  await updateRecord(rec);
  return c.json({ ok: true });
});

app.all('/v1/*', async (c) => {
  const targetPath = c.req.path.slice('/v1'.length); // includes leading '/'
  const url = `${CHATGPT_ENDPOINT}${targetPath}`;

  // Determine streaming based on payload if JSON
  let stream = false;
  let body: any;
  if (c.req.method === 'POST') {
    try {
      const text = await c.req.text();
      body = text;
      const json = JSON.parse(text);
      stream = !!json?.stream;
    } catch {
      body = (c.req.raw as Request).body;
    }
  } else {
    body = undefined;
  }
  const tryOnce = async (token: TokenRecord) => {
    const upstreamHeaders = new Headers(c.req.raw.headers);
    upstreamHeaders.set('Authorization', `Bearer ${token.access_token}`);
    upstreamHeaders.set('Openai-Beta', 'responses=experimental');
    upstreamHeaders.set('Content-Type', 'application/json');
    upstreamHeaders.set('Version', '0.21.0');
    upstreamHeaders.set('Session_id', randomUUID());
    if (token.account_id)
      upstreamHeaders.set('Chatgpt-Account-Id', token.account_id);
    upstreamHeaders.set('Originator', 'codex_cli_rs');
    upstreamHeaders.set('Accept', stream ? 'text/event-stream' : 'application/json');
    return fetch(url, { method: c.req.method, headers: upstreamHeaders, body });
  };

  const { rec: first, total } = await selectNextToken();
  if (!first) return c.json({ error: 'No usable accounts (all disabled, cooling down or expired)' }, 503);
  const maxAttempts = Math.min(total, 3) || 1;
  let current = first;
  let resp = await tryOnce(current);
  if (resp.status === 401 || resp.status === 403) {
    const refreshed = await refreshToken(current);
    if (refreshed) {
      current = refreshed;
      resp = await tryOnce(current);
    }
  }
  const retriable = (code: number) => code === 429 || code === 403 || code === 408 || code === 500 || code === 502 || code === 503 || code === 504;
  let attempts = 1;
  while (attempts < maxAttempts && retriable(resp.status)) {
    await markFailure(current, resp.status);
    const sel = await selectNextToken();
    if (!sel.rec) break;
    current = sel.rec;
    resp = await tryOnce(current);
    attempts++;
  }

  // Forward response
  const headers = new Headers(resp.headers);
  if (stream) {
    headers.set('Cache-Control', 'no-cache');
    headers.set('Connection', 'keep-alive');
    if (!headers.get('Content-Type')?.includes('text/event-stream')) {
      headers.set('Content-Type', 'text/event-stream');
    }
  } else {
    if (!headers.get('Content-Type')?.includes('application/json')) {
      headers.set('Content-Type', 'application/json');
    }
  }

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
});

// Start Node server on 1455 (includes callback route)
serve({ fetch: app.fetch, port: PORT });
console.log(
  `Codex Equilibrium Node server listening on http://localhost:${PORT}`
);

// Background refresh loop: refresh tokens close to expiry, with jitter
async function refreshDueTokens() {
  try {
    const list = await readTokens();
    for (const rec of list) {
      if (rec.disabled) continue;
      if (isNearExpiry(rec.expire, 10 * 60 * 1000)) {
        await refreshToken(rec);
      }
    }
  } catch {}
}

function scheduleNextRefresh() {
  const base = 15 * 60 * 1000; // 15m
  const jitter = Math.floor((Math.random() * 6 - 3) * 60 * 1000); // ±3m
  const delay = Math.max(60 * 1000, base + jitter); // at least 1m
  setTimeout(async () => {
    await refreshDueTokens();
    scheduleNextRefresh();
  }, delay);
}

// Initial check and schedule
refreshDueTokens();
scheduleNextRefresh();
