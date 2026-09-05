import express from 'express';
import { Database } from './db.js';
import { settings } from './config.js';
import { SOURCES, fetchAllSources } from './sources.js';
import { checkAll } from './checker.js';
import { networkGuard } from './network.js';

const db = await Database.open();
const app = express();
let workerRunning = false;
let refreshInProgress = false;
let lastRefresh = null;
let lastCheck = null;
let lastFetchAt = 0;
let workerTimer = null;
let wakeWorker = null;
let shuttingDown = false;
let lastCycle = null;

function runtimeStatus() {
  return { version: 'socket-lifecycle-v2', uptime_seconds: Math.floor(process.uptime()),
    rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    resources: process.getActiveResourcesInfo().reduce((counts, name) => {
      counts[name] = (counts[name] || 0) + 1;
      return counts;
    }, {}), network: networkGuard.status(settings.checkConcurrency), last_cycle: lastCycle };
}

function workerDelay(milliseconds) {
  return new Promise((resolve) => {
    wakeWorker = resolve;
    workerTimer = setTimeout(resolve, milliseconds);
  }).finally(() => {
    workerTimer = null;
    wakeWorker = null;
  });
}

function auth(req, res, next) {
  if (settings.apiKey && req.get('X-API-Key') !== settings.apiKey) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

async function fetchAll() {
  const results = await fetchAllSources();
  const summary = {};
  let total = 0;
  let changed = false;
  for (const { source, result } of results) {
    if (result.status === 'fulfilled') {
      db.addMany(result.value, source[0], { persist: false });
      summary[source[0]] = result.value.size;
      total += result.value.size;
      changed ||= result.value.size > 0;
    } else {
      summary[source[0]] = 0;
      const reason = result.reason;
      console.error(`[source] ${source[0]} failed: ${reason?.code || reason?.response?.status || reason?.name || 'Error'}`);
    }
  }
  if (changed) db.save();
  lastRefresh = new Date().toISOString();
  lastFetchAt = Date.now();
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
  while (workerRunning) {
    if (networkGuard.paused()) {
      console.warn(`[worker] ${new Date().toISOString()} network_cooldown=${JSON.stringify(networkGuard.status(settings.checkConcurrency))}`);
      await workerDelay(Math.min(30000, networkGuard.status(settings.checkConcurrency).retry_in_seconds * 1000));
      continue;
    }
    if (refreshInProgress) {
      await workerDelay(settings.checkIntervalSeconds * 1000);
      continue;
    }
    refreshInProgress = true;
    try {
      const now = Date.now();
      let fetchedThisCycle = false;
      if (now - lastFetchAt >= settings.fetchIntervalSeconds * 1000) {
        await fetchAll();
        fetchedThisCycle = true;
      }
      const first = await checkAll(db, { staleOnly: true });
      const second = fetchedThisCycle ? await checkAll(db, { aliveOnly: true }) : null;
      db.prune();
      lastCheck = new Date().toISOString();
      const stats = db.stats();
      lastCycle = { at: lastCheck, tested: first.tested + (second?.tested || 0),
        failed: first.failed + (second?.failed || 0), deferred: first.deferred + (second?.deferred || 0),
        skipped: first.skipped + (second?.skipped || 0), unexpected: first.unexpected + (second?.unexpected || 0),
        errors: { first: first.errorTypes, second: second?.errorTypes || {} } };
      console.log(`[worker] tested=${lastCycle.tested} stable=${stats.stable} failed=${lastCycle.failed} diagnostics=${JSON.stringify(runtimeStatus())}`);
    } catch (error) {
      console.error(`[worker] ${error.name || 'Error'}: ${error.message || error}`);
    } finally {
      refreshInProgress = false;
    }
    if (workerRunning) await workerDelay(settings.checkIntervalSeconds * 1000);
  }
}

app.get('/', (_req, res) => res.json({ name: 'Proxy Pool API', docs: '/docs', health: '/health', json: '/proxies', text: '/proxies.txt', protocols: ['http', 'https', 'socks4', 'socks5'] }));
app.get('/health', (_req, res) => {
  const stats = db.stats();
  res.json({ ok: !networkGuard.paused() && stats.healthy >= settings.targetPoolSize, worker_running: workerRunning, refresh_in_progress: refreshInProgress, last_refresh: lastRefresh, last_check: lastCheck, ...stats, runtime: runtimeStatus() });
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
  if (networkGuard.paused()) return res.status(503).json({ error: 'Local network cooldown', ...networkGuard.status(settings.checkConcurrency) });
  if (refreshInProgress) return res.status(409).json({ error: 'Refresh already running' });
  try { res.json(await refreshCycle()); } catch (error) { res.status(500).json({ error: error.message || 'Refresh failed' }); }
});
app.get('/metrics', auth, (_req, res) => res.json({ ...db.stats(), protocols: db.protocolCounts(), sources: SOURCES.length, worker_running: workerRunning, last_refresh: lastRefresh, last_check: lastCheck }));

const server = app.listen(Number(process.env.PORT) || 8000, '0.0.0.0', () => console.log(`Proxy Pool API listening on ${server.address().port}`));
workerRunning = true;
const workerPromise = worker().catch((error) => {
  console.error(`[worker] fatal ${error.name || 'Error'}: ${error.message || error}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  workerRunning = false;
  if (workerTimer) clearTimeout(workerTimer);
  wakeWorker?.();
  const serverClosed = new Promise((resolve) => server.close(resolve));
  let graceful = true;
  await Promise.race([
    Promise.allSettled([workerPromise, serverClosed]),
    new Promise((resolve) => setTimeout(() => { graceful = false; resolve(); }, 10000)),
  ]);
  db.close();
  console.log(`Shutdown after ${signal}${graceful ? '' : ' (deadline reached)'}`);
  process.exit(graceful ? 0 : 1);
}
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
