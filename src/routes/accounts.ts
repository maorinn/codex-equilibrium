import { Hono } from 'hono';
import { readRR, readTokens, removeRecord, updateRecord, writeRR, writeTokens } from '../storage.js';
import { maskToken, isCoolingDown, isExpired, decodeJwtPayload, parseExpireSeconds } from '../utils.js';
import { refreshToken } from '../refresh.js';
import type { TokenRecord } from '../types.js';
import { randomUUID } from 'crypto';

export function registerAccounts(app: Hono) {
  app.get('/accounts', async (c) => {
    const tokens = await readTokens();
    let rr = await readRR();
    if (!Number.isFinite(rr) || rr < 0 || rr >= tokens.length) rr = 0;
    const now = Date.now();
    const accounts = tokens.map((t: TokenRecord, i: number) => {
      let status = 'unknown';
      let expires_in_seconds: number | undefined;
      if (t.disabled) status = 'disabled';
      else if (t.cooldown_until && Date.parse(t.cooldown_until) > now)
        status = 'cooldown';
      else if (t.expire) {
        const tms = Date.parse(t.expire);
        if (!Number.isNaN(tms)) {
          const diff = Math.floor((tms - now) / 1000);
          expires_in_seconds = diff;
          if (diff <= 0) status = 'expired';
          else if (diff <= 5 * 60) status = 'expiring-soon';
          else status = 'active';
        }
      } else {
        status = 'active';
      }

      const usable = !t.disabled && !isCoolingDown(t) && !isExpired(t);
      let ui_state: 'active' | 'waiting' | 'frozen' = 'waiting';
      if (!usable) ui_state = 'frozen';
      else if (i === rr) ui_state = 'active';

      const cooldown_until_ms = t.cooldown_until
        ? Date.parse(t.cooldown_until)
        : NaN;
      const cooldown_remaining_seconds =
        !Number.isNaN(cooldown_until_ms) && cooldown_until_ms > now
          ? Math.max(0, Math.floor((cooldown_until_ms - now) / 1000))
          : 0;

      return {
        id: t.id,
        type: t.type || 'oauth',
        email: t.type === 'relay' ? t.name : t.email,
        account_id: t.type === 'relay' ? t.base_url : t.account_id,
        created_at: t.created_at,
        last_refresh: t.last_refresh,
        last_used: t.last_used,
        expire: t.expire,
        expires_in_seconds,
        status,
        ui_state,
        cooldown_until: t.cooldown_until,
        cooldown_remaining_seconds,
        fail_count: t.fail_count || 0,
        last_error_code: t.last_error_code,
        disabled: !!t.disabled,
        token: maskToken(t.type === 'relay' ? t.api_key || '' : t.access_token || ''),
      };
    });
    return c.json({ accounts });
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
    const rec = tokens.find((t: TokenRecord) => t.id === id);
    if (!rec) return c.json({ error: 'not found' }, 404);
    rec.disabled = true;
    await updateRecord(rec);
    return c.json({ ok: true });
  });

  app.post('/accounts/:id/enable', async (c) => {
    const id = c.req.param('id');
    const tokens = await readTokens();
    const rec = tokens.find((t: TokenRecord) => t.id === id);
    if (!rec) return c.json({ error: 'not found' }, 404);
    rec.disabled = false;
    await updateRecord(rec);
    return c.json({ ok: true });
  });

  // Import a token set obtained via CLI OAuth
  app.post('/accounts/import', async (c) => {
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {}
    const access_token = body?.access_token;
    if (!access_token) return c.json({ error: 'missing_access_token' }, 400);
    const refresh_token = body?.refresh_token;
    const id_token = body?.id_token;
    const expires_in = body?.expires_in;
    const expire = body?.expire;

    const meta = decodeJwtPayload(id_token);
    const rec: TokenRecord = {
      id: randomUUID(),
      type: 'oauth',
      access_token,
      refresh_token,
      id_token,
      account_id: meta.account_id,
      email: meta.email,
      expire: expire ?? parseExpireSeconds(expires_in),
      created_at: new Date().toISOString(),
      last_refresh: new Date().toISOString(),
      fail_count: 0,
      last_error_code: undefined,
      disabled: false,
    };
    const tokens = await readTokens();
    tokens.push(rec);
    await writeTokens(tokens);
    return c.json({ ok: true, id: rec.id, email: rec.email });
  });

  // Add a Relay proxy account
  app.post('/accounts/relay', async (c) => {
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {}
    const name = (body?.name || '').trim();
    const base_url = (body?.base_url || '').trim();
    const api_key = (body?.api_key || '').trim();
    if (!name) return c.json({ error: 'missing_name' }, 400);
    if (!base_url) return c.json({ error: 'missing_base_url' }, 400);
    if (!api_key) return c.json({ error: 'missing_api_key' }, 400);
    const rec: TokenRecord = {
      id: randomUUID(),
      type: 'relay',
      name,
      base_url,
      api_key,
      created_at: new Date().toISOString(),
      disabled: false,
      fail_count: 0,
    };
    const tokens = await readTokens();
    tokens.push(rec);
    await writeTokens(tokens);
    return c.json({ ok: true, id: rec.id, name: rec.name });
  });

  // Activate a specific account/relay (set rr index to it)
  app.post('/accounts/:id/activate', async (c) => {
    const id = c.req.param('id');
    const tokens = await readTokens();
    const idx = tokens.findIndex((t) => t.id === id);
    if (idx < 0) return c.json({ error: 'not_found' }, 404);
    await writeRR(idx);
    return c.json({ ok: true, index: idx });
  });
}
