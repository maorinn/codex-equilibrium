import { promises as fs } from 'fs';
import { AUTH_DIR, TOKENS_FILE, RR_INDEX_FILE } from './config.js';
import { ensureAuthDir } from './utils.js';
import type { TokenRecord } from './types.js';

// Simple async mutex for file operations
class Mutex {
  private q: Promise<void> = Promise.resolve();
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.q.then(fn);
    this.q = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
const tokenMutex = new Mutex();
const rrMutex = new Mutex();

async function atomicWrite(filePath: string, content: string) {
  await ensureAuthDir();
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

export async function readTokens(): Promise<TokenRecord[]> {
  return tokenMutex.lock(async () => {
    await ensureAuthDir();
    try {
      const data = await fs.readFile(TOKENS_FILE, 'utf8');
      return JSON.parse(data);
    } catch {
      return [] as TokenRecord[];
    }
  });
}

export async function writeTokens(tokens: TokenRecord[]) {
  await tokenMutex.lock(async () => {
    await ensureAuthDir();
    await atomicWrite(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  });
}

export async function readRR(): Promise<number> {
  return rrMutex.lock(async () => {
    try {
      return parseInt(await fs.readFile(RR_INDEX_FILE, 'utf8'), 10) || 0;
    } catch {
      return 0;
    }
  });
}

export async function writeRR(v: number) {
  await rrMutex.lock(async () => {
    await atomicWrite(RR_INDEX_FILE, String(v));
  });
}

export async function updateRecord(updated: TokenRecord) {
  const list = await readTokens();
  const idx = list.findIndex((t) => t.id === updated.id);
  if (idx >= 0) {
    list[idx] = updated;
    await writeTokens(list);
  }
}

export async function removeRecord(id: string) {
  const list = await readTokens();
  const next = list.filter((t) => t.id !== id);
  await writeTokens(next);
}
