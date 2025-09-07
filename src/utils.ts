import { promises as fs } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { AUTH_DIR } from './config.js';
import type { TokenRecord } from './types.js';

export async function ensureAuthDir() {
  try {
    await fs.mkdir(AUTH_DIR, { recursive: true });
  } catch {}
}

export function b64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function generateCodeVerifier(): string {
  // 96 random bytes -> 128 base64url chars (matches internal)
  return randomBytes(96).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  const digest = createHash('sha256').update(verifier).digest();
  return b64url(digest);
}

export function randomState(): string {
  return randomBytes(24).toString('base64url');
}

export function setCookie(c: any, name: string, value: string) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  const url = new URL(c.req.url);
  if (url.protocol === 'https:') attrs.push('Secure');
  c.header('Set-Cookie', attrs.join('; '), { append: true });
}

export function getCookie(c: any, name: string): string | undefined {
  const cookie = c.req.header('Cookie') || '';
  const parts = cookie.split(/;\s*/);
  for (const p of parts) {
    const [k, ...rest] = p.split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function decodeJwtPayload(idToken?: string): {
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

export function parseExpireSeconds(expires_in?: any): string | undefined {
  const n = Number(expires_in);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(Date.now() + n * 1000).toISOString();
}

export function isNearExpiry(
  expire?: string,
  thresholdMs = 10 * 60 * 1000
): boolean {
  if (!expire) return true;
  const t = Date.parse(expire);
  if (Number.isNaN(t)) return true;
  return t - Date.now() <= thresholdMs;
}

export function isCoolingDown(rec: TokenRecord): boolean {
  if (!rec.cooldown_until) return false;
  const t = Date.parse(rec.cooldown_until);
  return !Number.isNaN(t) && t > Date.now();
}

export function isExpired(rec: TokenRecord): boolean {
  if (!rec.expire) return false;
  const t = Date.parse(rec.expire);
  return Number.isNaN(t) ? false : t <= Date.now();
}

export function maskToken(token: string) {
  if (!token || token.length < 10) return token;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
