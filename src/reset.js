// Deletes the demo database so the next server start rebuilds the baseline.
// Everything in it is derived from the deterministic seed plus the recorded
// repairs/releases, so resetting loses nothing that cannot be replayed.

import { rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dbPath = process.env.FCX_DB || join(ROOT, 'data', 'fcx.db');

let removed = 0;
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  const path = dbPath + suffix;
  if (!existsSync(path)) continue;
  rmSync(path);
  removed++;
  console.log(`removed ${path}`);
}
if (removed === 0) console.log(`nothing to reset at ${dbPath}`);
