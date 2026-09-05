import axios from 'axios';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { settings } from './config.js';
import { errorCode, isResourceError, networkGuard } from './network.js';

function agentsFor(proxy, signal) {
  const timeout = settings.checkTimeoutSeconds * 1000;
  const normalized = proxy.startsWith('https://') ? `http://${proxy.slice(8)}` : proxy;
  if (normalized.startsWith('socks4://') || normalized.startsWith('socks5://')) {
    const agent = new SocksProxyAgent(normalized, { timeout, socketOptions: { signal } });
    return { httpAgent: agent, httpsAgent: agent };
  }
  // Agent.destroy() cannot see sockets still awaiting CONNECT. Cancel the
  // underlying net/tls socket too, not just Axios's ClientRequest.
  const options = { signal, timeout, keepAlive: false };
  return { httpAgent: new HttpProxyAgent(normalized, options), httpsAgent: new HttpsProxyAgent(normalized, options) };
}

async function probe(proxy, signal) {
  const agents = agentsFor(proxy, signal);
  try {
    for (const target of settings.checkTargets) {
      const response = await axios.get(target, {
        ...agents,
        proxy: false,
        timeout: settings.checkTimeoutSeconds * 1000,
        signal,
        maxRedirects: 0,
        maxContentLength: 64 * 1024,
        validateStatus: () => true,
        headers: { 'User-Agent': 'proxy-pool-health-check/3.0' },
      });
      if (response.status !== 204) return false;
    }
    return true;
  } finally {
    agents.httpAgent?.destroy?.();
    if (agents.httpsAgent !== agents.httpAgent) agents.httpsAgent?.destroy?.();
  }
}

export async function checkOne(proxy) {
  const started = performance.now();
  const timeoutMs = settings.checkTimeoutSeconds * 1000;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  deadline.unref?.();
  try {
    const passed = await probe(proxy, controller.signal);
    const latency = Math.round((performance.now() - started) * 100) / 100;
    const alive = passed && latency <= timeoutMs;
    return { proxy, alive, latency: alive ? latency : null, error: null };
  } catch (error) {
    const code = errorCode(error);
    const reason = isResourceError(code) ? code : (controller.signal.aborted ? 'TimeoutError' : code);
    return { proxy, alive: false, latency: null, error: reason };
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}

async function mapConcurrent(values, concurrency, mapper, guard) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      if (guard.paused()) return;
      const index = next++;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index]);
      } catch (error) {
        results[index] = {
          proxy: values[index], alive: false, latency: null,
          error: errorCode(error),
        };
      }
      results[index].checkedAt = new Date().toISOString();
      guard.fail(results[index].error, settings.checkConcurrency);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function checkAll(db, { aliveOnly = false, staleOnly = false,
  checker = checkOne, guard = networkGuard } = {}) {
  let proxies = db.candidates({ aliveOnly, staleOnly });
  if (settings.maxCandidatesPerCycle > 0) proxies = proxies.slice(0, settings.maxCandidatesPerCycle);
  const errorTypes = {};
  let failed = 0;
  let unexpected = 0;
  let tested = 0;
  let deferred = 0;
  let succeeded = 0;
  const batchSize = Math.max(settings.checkConcurrency, settings.checkPersistBatchSize);

  for (let offset = 0; offset < proxies.length; offset += batchSize) {
    if (guard.paused()) break;
    const batch = proxies.slice(offset, offset + batchSize);
    const results = await mapConcurrent(batch, guard.concurrency(settings.checkConcurrency), checker, guard);
    const checks = [];
    for (const result of results) {
      if (!result) continue;
      tested++;
      if (result.error) errorTypes[result.error] = (errorTypes[result.error] || 0) + 1;
      // During host exhaustion a failed attempt is not evidence of a dead proxy.
      if (!result.alive && guard.paused()) { deferred++; continue; }
      if (!result.alive) {
        failed += 1;
        checks.push([result.proxy, false, null, result.checkedAt]);
      } else {
        succeeded++;
        checks.push([result.proxy, true, result.latency, result.checkedAt]);
      }
    }
    try {
      db.updateChecks(checks);
    } catch (error) {
      unexpected += checks.length;
      const name = `database:${error.name || 'Error'}`;
      errorTypes[name] = (errorTypes[name] || 0) + checks.length;
    }
  }
  if (succeeded > 0 && !guard.paused()) guard.succeeded(settings.checkConcurrency);
  return { tested, failed, succeeded, deferred, skipped: proxies.length - tested, unexpected, errorTypes };
}
