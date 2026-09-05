import express from 'express';
import { Database } from './db.js';
import { settings } from './config.js';
import { SOURCES } from './sources.js';
import { networkGuard } from './network.js';
import { PoolWorker } from './worker.js';

const db = await Database.open();
const app = express();
let shuttingDown = false;
const worker = new PoolWorker(db, { logger(lane, summary) {
  if (lane === 'sources') {
    console.log('[sources] ' + JSON.stringify(summary));
  } else if (lane === 'error') {
    console.error('[worker-error] ' + JSON.stringify(summary));
  } else {
    console.log('[worker:' + lane + '] tested=' + summary.tested + ' stable=' + db.stats().stable +
      ' failed=' + summary.failed + ' diagnostics=' + JSON.stringify({ ...runtimeStatus(), last_cycle: summary }));
  }
} });

function runtimeStatus() {
  return { version: 'live-scheduler-v3', uptime_seconds: Math.floor(process.uptime()),
    rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    resources: process.getActiveResourcesInfo().reduce((counts, name) => {
      counts[name] = (counts[name] || 0) + 1;
      return counts;
    }, {}), network: networkGuard.status(settings.checkConcurrency),
    scheduler: worker.scheduler.status(), worker_errors: worker.errors };
}

function auth(req, res, next) {
  if (settings.apiKey && req.get('X-API-Key') !== settings.apiKey) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

function limitOf(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 500) || 1 : fallback;
}

app.get('/', (_req, res) => res.json({ name: 'Proxy Pool API', health: '/health', json: '/proxies', text: '/proxies.txt', protocols: ['http', 'https', 'socks4', 'socks5'] }));
app.get('/health', (_req, res) => {
  const stats = db.stats();
  res.json({ ok: worker.running && !networkGuard.paused() && !Object.keys(worker.errors).length && stats.healthy >= settings.targetPoolSize,
    worker_running: worker.running, refresh_in_progress: !!worker.sourcePromise,
    last_refresh: worker.lastRefresh, last_check: worker.cycles.live?.at || null,
    ...stats, runtime: runtimeStatus(), workers: worker.status() });
});
app.get('/proxies', auth, (req, res) => {
  const proxies = db.healthy(limitOf(req.query.limit, 50));
  res.json({ count: proxies.length, proxies });
});
app.get('/proxies.txt', auth, (req, res) => res.type('text/plain').send(db.healthy(limitOf(req.query.limit, 500)).join('\n') + '\n'));
app.get('/proxies/:protocol', auth, (req, res) => {
  const protocol = req.params.protocol.toLowerCase();
  if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) return res.status(400).json({ error: 'Protocol must be http, https, socks4 or socks5' });
  const proxies = db.healthyProtocol(protocol, limitOf(req.query.limit, 50));
  res.json({ protocol, count: proxies.length, proxies });
});
app.post('/refresh', auth, async (_req, res) => {
  if (networkGuard.paused()) return res.status(503).json({ error: 'Local network cooldown', ...networkGuard.status(settings.checkConcurrency) });
  if (!worker.running) return res.status(503).json({ error: 'Worker stopped' });
  try {
    const sources = await worker.refresh();
    res.status(202).json({ message: 'Sources refreshed; background checking continues', sources });
  } catch (error) { res.status(500).json({ error: error.message || 'Refresh failed' }); }
});
app.get('/metrics', auth, (_req, res) => res.json({ ...db.stats(), protocols: db.protocolCounts(), sources: SOURCES.length,
  worker_running: worker.running, last_refresh: worker.lastRefresh, last_check: worker.cycles.live?.at || null,
  runtime: runtimeStatus(), workers: worker.status() }));

const server = app.listen(Number(process.env.PORT) || 8000, '0.0.0.0', () => {
  console.log('Proxy Pool API listening on ' + server.address().port + ' version=live-scheduler-v3');
  worker.start();
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => { console.error('[shutdown] deadline reached'); process.exit(1); }, 10000);
  try {
    const closed = new Promise((resolve) => server.close(resolve));
    await worker.stop();
    server.closeAllConnections();
    await closed;
    db.close();
    clearTimeout(deadline);
    console.log('Shutdown after ' + signal);
    process.exit(0);
  } catch (error) {
    console.error('[shutdown] ' + (error.message || error));
    process.exit(1);
  }
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
