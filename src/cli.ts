#!/usr/bin/env node
import http from 'http';
import { URL } from 'url';
import { spawn } from 'child_process';
import {
  OPENAI_AUTH_URL,
  OPENAI_CLIENT_ID,
  OPENAI_TOKEN_URL,
  REDIRECT_URI,
} from './config.js';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  randomState,
} from './utils.js';

type Args = {
  command?: string;
  server?: string;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { command: undefined, server: undefined };
  const rest = argv.slice(2);
  if (rest.length > 0) out.command = rest[0];
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--server' || a === '-s') {
      out.server = rest[i + 1];
      i++;
    }
  }
  return out;
}

async function openBrowser(url: string) {
  const plat = process.platform;
  const cmds =
    plat === 'darwin'
      ? ['open']
      : plat === 'win32'
      ? ['cmd', '/c', 'start', '']
      : ['xdg-open'];
  try {
    const child = spawn(cmds[0], cmds.slice(1).concat([url]), {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  } catch {}
}

async function exchangeCode({
  code,
  verifier,
}: {
  code: string;
  verifier: string;
}) {
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
    throw new Error(`Token exchange failed: ${resp.status} ${t}`);
  }
  return resp.json();
}

async function importTokens(serverBase: string, tokens: any) {
  const url = new URL('/accounts/import', serverBase);
  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Import failed: ${resp.status} ${t}`);
  }
  return resp.json();
}

async function login(serverBase?: string) {
  const base = serverBase || 'http://127.0.0.1:1456';
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = randomState();

  // Start a minimal local callback server on 1455
  const urlObj = new URL(REDIRECT_URI);
  const listenPort = Number(urlObj.port || '1455');
  const listenPath = urlObj.pathname || '/auth/callback';

  const gotCode = new Promise<{ code: string; state?: string }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return;
      try {
        const u = new URL(req.url, `http://localhost:${listenPort}`);
        if (u.pathname !== listenPath) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        const code = u.searchParams.get('code') || '';
        const st = u.searchParams.get('state') || undefined;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Login</title></head><body><p>Authentication successful. You can close this window.</p><script>setTimeout(()=>{window.close&&window.close();},1500)</script></body></html>`);
        server.close();
        resolve({ code, state: st });
      } catch (e) {
        res.statusCode = 500;
        res.end('Error');
      }
    });
    server.on('error', (err) => {
      reject(err);
    });
    server.listen(listenPort, '127.0.0.1');
  });

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
  const authUrl = `${OPENAI_AUTH_URL}?${params.toString()}`;

  console.log('Open this URL in a browser to authenticate:');
  console.log(authUrl);
  await openBrowser(authUrl);

  const { code, state: backState } = await gotCode;
  if (!code) throw new Error('Missing authorization code');
  if (!backState || backState !== state) throw new Error('State mismatch');

  console.log('Exchanging code for tokens...');
  const json: any = await exchangeCode({ code, verifier });
  const { access_token, refresh_token, id_token, expires_in } = json;
  if (!access_token) throw new Error('No access_token in response');

  console.log(`Importing account to server ${base} ...`);
  const result = await importTokens(base, {
    access_token,
    refresh_token,
    id_token,
    expires_in,
  });
  console.log('Import result:', result);
  console.log('Login complete.');
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.command || args.command === 'help' || args.command === '--help') {
    console.log('Usage:');
    console.log('  codex-equilibrium login --server http://localhost:1456');
    console.log('  npm run login -- --server http://localhost:1456');
    process.exit(0);
  }
  if (args.command === 'login') {
    try {
      await login(args.server);
    } catch (e: any) {
      console.error(e?.message || String(e));
      process.exit(1);
    }
    return;
  }
  console.error(`Unknown command: ${args.command}`);
  process.exit(1);
}

main();
