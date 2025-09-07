import { OPENAI_CLIENT_ID, OPENAI_TOKEN_URL } from './config.js';
import type { TokenRecord } from './types.js';
import { decodeJwtPayload, isNearExpiry, parseExpireSeconds } from './utils.js';
import { readTokens, updateRecord } from './storage.js';

const refreshing = new Set<string>();

export async function refreshToken(
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
      else if (
        code === 408 ||
        code === 500 ||
        code === 502 ||
        code === 503 ||
        code === 504
      ) {
        const fc = updatedFail.fail_count || 1;
        cooldownMs = Math.min(
          30 * 60 * 1000,
          (1 << Math.min(fc, 5)) * 60 * 1000
        );
      }
      if (cooldownMs > 0)
        updatedFail.cooldown_until = new Date(
          Date.now() + cooldownMs
        ).toISOString();
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

export function computeCooldownMs(code: number, _failCount: number): number {
  // Enforce 3-hour cooldown on persistent failures (429 and other retriable errors)
  if (
    code === 429 ||
    code === 401 ||
    code === 403 ||
    code === 408 ||
    code === 500 ||
    code === 502 ||
    code === 503 ||
    code === 504
  ) {
    return 3 * 60 * 60 * 1000; // 3 hours
  }
  return 0;
}

export async function markFailure(rec: TokenRecord, code: number) {
  const fc = (rec.fail_count || 0) + 1;
  const cooldownMs = computeCooldownMs(code, fc);
  const updated: TokenRecord = {
    ...rec,
    fail_count: fc,
    last_error_code: code,
    cooldown_until:
      cooldownMs > 0
        ? new Date(Date.now() + cooldownMs).toISOString()
        : rec.cooldown_until,
  };
  await updateRecord(updated);
}

export async function refreshDueTokens() {
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

export function scheduleNextRefresh() {
  const base = 15 * 60 * 1000; // 15m
  const jitter = Math.floor((Math.random() * 6 - 3) * 60 * 1000); // ±3m
  const delay = Math.max(60 * 1000, base + jitter); // at least 1m
  setTimeout(async () => {
    await refreshDueTokens();
    scheduleNextRefresh();
  }, delay);
}
