# Codex Equilibrium

A lightweight Node.js service built with [Hono](https://hono.dev/) for balancing multiple OpenAI Codex (ChatGPT) OAuth accounts. It implements the OAuth flow locally (including the callback), persists tokens to disk, and proxies `/v1/*` to the ChatGPT Codex backend with stream support.

## Features

- Local OAuth with PKCE, fixed redirect `http://localhost:1455/auth/callback`.
- Persistent storage in `auths/` (JSON file + sticky index).
- Sticky account usage: keep using the same account until it fails.
  On 429 or other errors, retry once, then try a token refresh;
  if still failing, disable that account for 3 hours and move to the next by add order.
- Simple web UI to start OAuth login and view accounts.
- `/v1/*` proxy to `https://chatgpt.com/backend-api/codex/*` with SSE stream support.

## Run

```bash
cd codex-equilibrium
npm install
npm run build
npm start
```

Open http://localhost:1456/ and click “Add OpenAI Account” to complete OAuth (or use the CLI login below). Tokens are saved to `auths/codex_tokens.json`.

## CLI Login (headless server support)

You can add an account from a machine with a browser and import it into a remote server:

```bash
# On your laptop (with a browser):
npm run login -- --server http://<server-host>:1456

# After publishing, you can also use:
npx codex-equilibrium login --server http://<server-host>:1456
```

The CLI opens an OAuth URL and listens on `http://localhost:1455/auth/callback` locally to receive the code, then exchanges tokens and sends them to the server (`POST /accounts/import`). Ensure port 1455 is free on the client machine during login.

## Using with Codex CLI

The following keys must appear at the very top of your `~/.codex/config.toml`:

```toml
model_provider = "codex_equilibrium"
model = "gpt-5"
model_reasoning_effort = "high"
```

Point your Codex client to the `/v1` proxy, for example:

```toml
# ~/.codex/config.toml
[model_providers.codex_equilibrium]
name = "codex_equilibrium"
base_url = "http://127.0.0.1:1456/v1"
wire_api = "responses"
```

Authentication is handled by this service via OAuth; an `OPENAI_API_KEY` is not required.

## Management API

- `GET /accounts` — list accounts: id, email, account_id, masked token, expire
- `DELETE /accounts/:id` — remove an account
- `POST /accounts/:id/refresh` — force refresh a token
