import express from 'express';
import { Database } from './db.js';
import { settings } from './config.js';
import { SOURCES, fetchAllSources } from './sources.js';
import { checkAll } from './checker.js';

const db = new Database();
const app = express();
let workerRunning = false;
let refreshInProgress = false;
let lastRefresh = null;
let lastCheck = null;

function auth(req, res, next) {
  if (settings.apiKey && req.get('X-API-Key') !== settings.apiKey) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

async function fetchAll() {
  const results = await fetchAllSources();
  const summary = {};
  let total = 0;
  for (const { source, result } of results) {
    if (result.status === 'fulfilled') {
      db.addMany(result.value, source[0]);
      summary[source[0]] = result.value.size;
      total += result.value.size;
    } else {
      summary[source[0]] = 0;
      const reason = result.reason;
      console.error(`[source] ${source[0]} failed: ${reason?.code || reason?.response?.status || reason?.name || 'Error'}`);
    }
  }
  lastRefresh = new Date().toISOString();
  console.log(`[worker] sources=${SOURCES.length} candidates=${total}`);
  return summary;
}

async function refreshCycle() {
  if (refreshInProgress) throw new Error('Refresh already running');
  refreshInProgress = true;
  try {
  const sources = await fetchAll();
  const first = await checkAll(db, { staleOnly: true });
  const second = await checkAll(db, { aliveOnly: true });
  const pruned = db.prune();
  lastCheck = new Date().toISOString();
  return { sources, first, second, pruned };
  } finally {
    refreshInProgress = false;
  }
}

async function worker() {
  let lastFetchAt = 0;
  while (workerRunning) {
    try {
      const now = Date.now();
      let fetchedThisCycle = false;
      if (now - lastFetchAt >= settings.fetchIntervalSeconds * 1000) {
        await fetchAll();
        lastFetchAt = Date.now();
        fetchedThisCycle = true;
      }
      const first = await checkAll(db, { staleOnly: true });
      const second = fetchedThisCycle ? await checkAll(db, { aliveOnly: true }) : null;
      db.prune();
      lastCheck = new Date().toISOString();
      const stats = db.stats();
      console.log(`[worker] tested=${first.tested + (second?.tested || 0)} stable=${stats.stable} failed=${first.failed + (second?.failed || 0)}`);
    } catch (error) {
      console.error(`[worker] ${error.name || 'Error'}: ${error.message || error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, settings.checkIntervalSeconds * 1000));
  }
}

app.get('/', (_req, res) => res.json({ name: 'Proxy Pool API', docs: '/docs', health: '/health', json: '/proxies', text: '/proxies.txt', protocols: ['http', 'https', 'socks4', 'socks5'] }));
app.get('/health', (_req, res) => {
  const stats = db.stats();
  res.json({ ok: stats.healthy >= settings.targetPoolSize, worker_running: workerRunning, refresh_in_progress: refreshInProgress, last_refresh: lastRefresh, last_check: lastCheck, ...stats });
});
app.get('/proxies', auth, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const proxies = db.healthy(limit);
  res.json({ count: proxies.length, proxies });
});
app.get('/proxies.txt', auth, (req, res) => res.type('text/plain').send(`${db.healthy(Math.min(Number(req.query.limit) || 500, 500)).join('\n')}\n`));
app.get('/proxies/:protocol', auth, (req, res) => {
  const protocol = req.params.protocol.toLowerCase();
  if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) return res.status(400).json({ error: 'Protocol must be http, https, socks4 or socks5' });
  const values = db.healthyProtocol(protocol, Math.min(Number(req.query.limit) || 50, 500));
  res.json({ protocol, count: values.length, proxies: values });
});
app.post('/refresh', auth, async (_req, res) => {
  if (refreshInProgress) return res.status(409).json({ error: 'Refresh already running' });
  try { res.json(await refreshCycle()); } catch (error) { res.status(500).json({ error: error.message || 'Refresh failed' }); }
});
app.get('/metrics', auth, (_req, res) => res.json({ ...db.stats(), protocols: db.protocolCounts(), sources: SOURCES.length, worker_running: workerRunning, last_refresh: lastRefresh, last_check: lastCheck }));

const server = app.listen(Number(process.env.PORT) || 8000, '0.0.0.0', () => console.log(`Proxy Pool API listening on ${server.address().port}`));
workerRunning = true;
worker();

function shutdown(signal) {
  workerRunning = false;
  server.close(() => { db.close(); console.log(`Shutdown after ${signal}`); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
