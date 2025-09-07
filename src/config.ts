import path from 'path';

// Server config
export const PORT = 1456;

// OAuth/OpenAI constants (aligned with internal/auth/codex)
export const OPENAI_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
export const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
// OAuth redirect must remain fixed to this URL (client-local callback)
export const REDIRECT_URI = 'http://localhost:1455/auth/callback';

// ChatGPT Codex backend
export const CHATGPT_ENDPOINT = 'https://chatgpt.com/backend-api/codex';

// Cookie names
export const COOKIE_STATE = 'oauth_state';
export const COOKIE_VERIFIER = 'oauth_verifier';

// Storage paths
export const AUTH_DIR = path.join(process.cwd(), 'auths');
export const TOKENS_FILE = path.join(AUTH_DIR, 'codex_tokens.json');
export const RR_INDEX_FILE = path.join(AUTH_DIR, 'rr-index');
