import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../src/db.js';
import { SOURCES, fetchAllSources } from '../src/sources.js';
import { checkAll } from '../src/checker.js';

const databasePath = process.env.DATABASE_PATH || 'data/actions.db';
const db = await Database.open(databasePath);

function flattenErrors(...results) {
  const errors = {};
  for (const result of results) {
    for (const [name, count] of Object.entries(result.errorTypes || {})) errors[name] = (errors[name] || 0) + count;
  }
  return errors;
}

function writeSnapshot(proxies) {
  const dataDir = path.resolve('data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'proxies.txt'), `${proxies.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(dataDir, 'proxies.json'), `${JSON.stringify({
    count: proxies.length,
    generated_at: new Date().toISOString(),
    protocols: db.protocolCounts(),
    proxies,
  }, null, 2)}\n`, 'utf8');
}

async function main() {
  console.log(`[snapshot] kaynak çekiliyor: ${SOURCES.length}`);
  const fetched = await fetchAllSources();
  let fetchedCandidates = 0;
  let failedSources = 0;
  for (const { source, result } of fetched) {
    if (result.status === 'fulfilled') {
      const count = result.value.size;
      fetchedCandidates += count;
      db.addMany(result.value, source[0]);
      console.log(`[source] ${source[0]}: ${count}`);
    } else {
      failedSources += 1;
      console.log(`[source] ${source[0]}: hata (${result.reason?.name || 'Error'})`);
    }
  }

  const first = await checkAll(db);
  const second = await checkAll(db, { aliveOnly: true });
  const stable = db.healthy(500);
  writeSnapshot(stable);
  const stats = db.stats();
  const protocols = db.protocolCounts();
  console.log(`[snapshot] aday: ${fetchedCandidates} | veritabanı: ${stats.total} | test: ${first.tested + second.tested} (${first.tested}+${second.tested}) | stabil: ${stable.length}`);
  console.log(`[snapshot] kaynak hatası: ${failedSources}/${SOURCES.length}`);
  console.log(`[snapshot] protokoller: HTTP=${protocols.HTTP || 0} HTTPS=${protocols.HTTPS || 0} SOCKS4=${protocols.SOCKS4 || 0} SOCKS5=${protocols.SOCKS5 || 0}`);
  console.log(`[snapshot] proxy test hataları: ${JSON.stringify(flattenErrors(first, second))}`);
  console.log('[snapshot] tamamlandı');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  console.error(`[snapshot] kontrollü hata: ${error?.name || 'Error'}: ${error?.message || error}`);
  exitCode = 1;
} finally {
  db.close();
}
process.exit(exitCode);
