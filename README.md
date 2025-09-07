# Codex Equilibrium

A lightweight Node.js service built with [Hono](https://hono.dev/) for balancing multiple OpenAI Codex (ChatGPT) OAuth accounts. It implements the OAuth flow locally (including the callback), persists tokens to disk, and proxies `/v1/*` to the ChatGPT Codex backend with stream support.

## Features

- Local OAuth with PKCE, fixed redirect `http://localhost:1455/auth/callback`.
- Persistent storage in `auths/` (JSON file + round-robin index).
- Round-robin load balancing across stored accounts.
- Simple web UI to start OAuth login and view accounts.
- `/v1/*` proxy to `https://chatgpt.com/backend-api/codex/*` with SSE stream support.

## Run

```bash
cd codex-equilibrium
npm install
npm run build
npm start
```

Open http://localhost:1455/ and click “Add OpenAI Account” to complete OAuth. Tokens are saved to `auths/codex_tokens.json`.

## Using with Codex CLI

Point your Codex client to the `/v1` proxy, for example:

```toml
# ~/.codex/config.toml
model_provider = "codex_equilibrium"
model = "gpt-5"
model_reasoning_effort = "high"

[model_providers.codex_equilibrium]
name = "codex_equilibrium"
base_url = "http://127.0.0.1:1455/v1"
wire_api = "responses"
```

Authentication is handled by this service via OAuth; an `OPENAI_API_KEY` is not required.

## Management API

- `GET /accounts` — list accounts: id, email, account_id, masked token, expire
- `DELETE /accounts/:id` — remove an account
- `POST /accounts/:id/refresh` — force refresh a token
