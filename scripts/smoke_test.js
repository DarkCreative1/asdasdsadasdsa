import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../src/db.js';
import { fetchAllSources } from '../src/sources.js';
import { checkAll } from '../src/checker.js';
import { settings } from '../src/config.js';

const limitArg = Number(process.argv[2] || 100);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-'));
const db = await Database.open(path.join(tempDir, 'smoke.db'));

try {
  const fetched = await fetchAllSources();
  let candidates = 0;
  for (const { source, result } of fetched) {
    if (result.status === 'fulfilled') {
      candidates += result.value.size;
      db.addMany(result.value, source[0]);
    }
  }
  settings.maxCandidatesPerCycle = Math.max(0, limitArg);
  const first = await checkAll(db);
  const second = await checkAll(db, { aliveOnly: true });
  const stable = db.healthy(500);
  console.log(JSON.stringify({ candidates, tested: first.tested + second.tested, stable: stable.length, protocols: db.protocolCounts(), errors: { first: first.errorTypes, second: second.errorTypes } }, null, 2));
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
process.exit(0);
