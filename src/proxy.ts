import { Hono } from 'hono';
import { CHATGPT_ENDPOINT } from './config.js';
import type { TokenRecord } from './types.js';
import { advanceToNextUsableToken, selectNextToken } from './selection.js';
import { markFailure, refreshToken } from './refresh.js';
import {
  convertChatChunkToCompletionsChunk,
  convertChatCompletionsToResponses,
  convertChatToCompletions,
  convertResponsesBlobToChat,
  mapResponsesLineToChat,
} from './converters.js';
import { randomUUID } from 'crypto';

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
    upstreamHeaders.set(
      'Accept',
      stream ? 'text/event-stream' : 'application/json'
    );
    return fetch(url, { method: 'POST', headers: upstreamHeaders, body });
  };

  const { rec: first, total } = await selectNextToken();
  if (!first)
    return c.json(
      { error: 'No usable accounts (all disabled, cooling down or expired)' },
      503
    );

  let current = first;
  let triedAccounts = 0;
  while (triedAccounts < (total || 1)) {
    let resp = await tryOnce(current);
    if (resp.ok) {
      if (stream) {
        const headers = new Headers(resp.headers);
        headers.set('Cache-Control', 'no-cache');
        headers.set('Connection', 'keep-alive');
        if (!headers.get('Content-Type')?.includes('text/event-stream')) {
          headers.set('Content-Type', 'text/event-stream');
        }
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers,
        });
      }
      const headers = new Headers(resp.headers);
      if (!headers.get('Content-Type')?.includes('application/json')) {
        headers.set('Content-Type', 'application/json');
      }
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
      });
    }

    // Retry once on same account if potentially transient
    if (
      resp.status === 408 ||
      resp.status === 500 ||
      resp.status === 502 ||
      resp.status === 503 ||
      resp.status === 504
    ) {
      resp = await tryOnce(current);
      if (resp.ok) {
        if (stream) {
          const headers = new Headers(resp.headers);
          headers.set('Cache-Control', 'no-cache');
          headers.set('Connection', 'keep-alive');
          if (!headers.get('Content-Type')?.includes('text/event-stream')) {
            headers.set('Content-Type', 'text/event-stream');
          }
          return new Response(resp.body, {
            status: resp.status,
            statusText: resp.statusText,
            headers,
          });
        }
        const headers = new Headers(resp.headers);
        if (!headers.get('Content-Type')?.includes('application/json')) {
          headers.set('Content-Type', 'application/json');
        }
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers,
        });
      }
    }

    if (
      !(resp.status === 429 ||
      resp.status === 401 ||
      resp.status === 403 ||
      resp.status === 408 ||
      resp.status === 500 ||
      resp.status === 502 ||
      resp.status === 503 ||
      resp.status === 504)
    ) {
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
    }

    // Try refresh (if possible), then try again
    const refreshed = await refreshToken(current);
    if (refreshed) {
      current = refreshed;
      resp = await tryOnce(current);
      if (resp.ok) {
        if (stream) {
          const headers = new Headers(resp.headers);
          headers.set('Cache-Control', 'no-cache');
          headers.set('Connection', 'keep-alive');
          if (!headers.get('Content-Type')?.includes('text/event-stream')) {
            headers.set('Content-Type', 'text/event-stream');
          }
          return new Response(resp.body, {
            status: resp.status,
            statusText: resp.statusText,
            headers,
          });
        }
        const headers = new Headers(resp.headers);
        if (!headers.get('Content-Type')?.includes('application/json')) {
          headers.set('Content-Type', 'application/json');
        }
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers,
        });
      }
    }

    // Final failure on this account → mark + cooldown and switch to next
    await markFailure(current, resp.status);
    triedAccounts++;
    const sel = await advanceToNextUsableToken();
    if (!sel.rec) {
      if (stream) {
        const headers = new Headers(resp.headers);
        headers.set('Cache-Control', 'no-cache');
        headers.set('Connection', 'keep-alive');
        if (!headers.get('Content-Type')?.includes('text/event-stream')) {
          headers.set('Content-Type', 'text/event-stream');
        }
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers,
        });
      }
      const headers = new Headers(resp.headers);
      if (!headers.get('Content-Type')?.includes('application/json')) {
        headers.set('Content-Type', 'application/json');
      }
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
      });
    }
    current = sel.rec;
  }

  // Fallback
  return c.json(
    { error: 'No usable accounts (all disabled, cooling down or expired)' },
    503
  );
}

// Robust streaming fetch to Responses endpoint with retry/switch logic
async function robustResponsesStreamFetch(
  c: any,
  bodyString: string
): Promise<Response | undefined> {
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
  const retriable = (code: number) =>
    code === 429 ||
    code === 403 ||
    code === 408 ||
    code === 500 ||
    code === 502 ||
    code === 503 ||
    code === 504;
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

export function registerProxy(app: Hono) {
  // POST /v1/responses (stream and non-stream)
  app.post('/v1/responses', async (c) => {
    const payload = await c.req.json();
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

  app.post('/v1/chat/completions', async (c) => {
    const original = await c.req.json();
    const converted = convertChatCompletionsToResponses(original);
    const stream = !!original?.stream;

    if (stream) {
      const resp = await robustResponsesStreamFetch(c, JSON.stringify(converted));
      if (!resp)
        return c.json(
          { error: 'No usable accounts (all disabled, cooling down or expired)' },
          503
        );
      if (!(resp.status >= 200 && resp.status < 300)) {
        return resp;
      }
      const originalChat = original;
      const revMap: Record<string, string> = {};
      const streamOut = new ReadableStream({
        async start(controller) {
          const reader = (resp.body as any).getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let state: { fnIdx?: number } = {};
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split(/\n\n/);
            buf = parts.pop() || '';
            for (const p of parts) {
              const s = p.trim();
              if (!s) continue;
              const mapped = mapResponsesLineToChat(s, revMap, state);
              if (mapped) {
                const comp = convertChatChunkToCompletionsChunk(mapped);
                if (comp) {
                  const line = 'data: ' + comp + '\n\n';
                  controller.enqueue(new TextEncoder().encode(line));
                }
              }
            }
          }
          controller.close();
        },
      });
      const outHeaders = new Headers(resp.headers);
      outHeaders.set('Content-Type', 'text/event-stream');
      outHeaders.set('Cache-Control', 'no-cache');
      outHeaders.set('Connection', 'keep-alive');
      return new Response(streamOut, {
        status: resp.status,
        headers: outHeaders,
      });
    } else {
      const res = await forwardResponses(c, converted);
      const text = await (res as any).text();
      const chat = convertResponsesBlobToChat(original, text);
      const comp = convertChatToCompletions(chat);
      return new Response(comp, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });

  app.all('/v1/*', async (c) => {
    const targetPath = c.req.path.slice('/v1'.length);
    const url = `${CHATGPT_ENDPOINT}${targetPath}`;

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
      upstreamHeaders.set(
        'Accept',
        stream ? 'text/event-stream' : 'application/json'
      );
      return fetch(url, { method: c.req.method, headers: upstreamHeaders, body });
    };

    const { rec: first, total } = await selectNextToken();
    if (!first)
      return c.json(
        { error: 'No usable accounts (all disabled, cooling down or expired)' },
        503
      );

    const shouldRetry = (code: number) =>
      code === 429 ||
      code === 401 ||
      code === 403 ||
      code === 408 ||
      code === 500 ||
      code === 502 ||
      code === 503 ||
      code === 504;

    let current = first;
    let triedAccounts = 0;
    while (triedAccounts < (total || 1)) {
      let resp = await tryOnce(current);
      if (resp.ok) {
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
      }

      if (!shouldRetry(resp.status)) {
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
      }

      // One retry on the same account
      resp = await tryOnce(current);
      if (resp.ok) {
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
      }

      // Try refresh, then try again
      const refreshed = await refreshToken(current);
      if (refreshed) {
        current = refreshed;
        resp = await tryOnce(current);
        if (resp.ok) {
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
        }
      }

      // Final failure on this account → mark cooldown and switch to next
      await markFailure(current, resp.status);
      triedAccounts++;
      const sel = await advanceToNextUsableToken();
      if (!sel.rec) {
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
      }
      current = sel.rec;
    }

    return c.json(
      { error: 'No usable accounts (all disabled, cooling down or expired)' },
      503
    );
  });
}
