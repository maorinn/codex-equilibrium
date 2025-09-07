import { Hono } from 'hono';
import {
  COOKIE_STATE,
  COOKIE_VERIFIER,
  OPENAI_AUTH_URL,
  OPENAI_CLIENT_ID,
  OPENAI_TOKEN_URL,
  REDIRECT_URI,
} from '../config.js';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  randomState,
  setCookie,
  getCookie,
  decodeJwtPayload,
  parseExpireSeconds,
} from '../utils.js';
import { html } from 'hono/html';
import { readTokens, writeTokens } from '../storage.js';
import type { TokenRecord } from '../types.js';
import { randomUUID } from 'crypto';

export function registerOAuth(app: Hono) {
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
}
