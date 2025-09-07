import type { TokenRecord } from './types.js';
import { isCoolingDown, isExpired } from './utils.js';
import { readRR, readTokens, updateRecord, writeRR } from './storage.js';

// Sticky selection: prefer current rr index if usable. Do not advance on read.
export async function selectNextToken(): Promise<{
  rec: TokenRecord | undefined;
  index: number;
  total: number;
}> {
  const tokens = await readTokens();
  const total = tokens.length;
  if (total === 0) return { rec: undefined, index: 0, total };
  let start = await readRR();
  if (!Number.isFinite(start) || start < 0 || start >= total) start = 0;

  const usable = (t: TokenRecord | undefined) =>
    !!t && !t.disabled && !isCoolingDown(t) && !isExpired(t);

  // Prefer current index
  const cur = tokens[start];
  if (usable(cur)) {
    cur.last_used = new Date().toISOString();
    await updateRecord(cur);
    return { rec: cur, index: start, total };
  }

  // Otherwise, find next usable and move rr pointer to it
  for (let i = 1; i < total; i++) {
    const idx = (start + i) % total;
    const t = tokens[idx];
    if (usable(t)) {
      await writeRR(idx);
      t.last_used = new Date().toISOString();
      await updateRecord(t);
      return { rec: t, index: idx, total };
    }
  }
  return { rec: undefined, index: start % total, total };
}

// Advance rr pointer to next usable account (by add order)
export async function advanceToNextUsableToken(): Promise<{
  rec: TokenRecord | undefined;
  index: number;
  total: number;
}> {
  const tokens = await readTokens();
  const total = tokens.length;
  if (total === 0) return { rec: undefined, index: 0, total };
  let start = await readRR();
  if (!Number.isFinite(start) || start < 0 || start >= total) start = 0;

  const usable = (t: TokenRecord | undefined) =>
    !!t && !t.disabled && !isCoolingDown(t) && !isExpired(t);

  for (let i = 1; i <= total; i++) {
    const idx = (start + i) % total;
    const t = tokens[idx];
    if (usable(t)) {
      await writeRR(idx);
      t.last_used = new Date().toISOString();
      await updateRecord(t);
      return { rec: t, index: idx, total };
    }
  }
  return { rec: undefined, index: start % total, total };
}
