import axios from 'axios';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { settings } from './config.js';

function agentsFor(proxy) {
  const normalized = proxy.startsWith('https://') ? `http://${proxy.slice(8)}` : proxy;
  if (normalized.startsWith('socks4://') || normalized.startsWith('socks5://')) {
    const agent = new SocksProxyAgent(normalized);
    return { httpAgent: agent, httpsAgent: agent };
  }
  return { httpAgent: new HttpProxyAgent(normalized), httpsAgent: new HttpsProxyAgent(normalized) };
}

async function probe(proxy, signal) {
  const agents = agentsFor(proxy);
  try {
    for (const target of settings.checkTargets) {
      const response = await axios.get(target, {
        ...agents,
        proxy: false,
        timeout: settings.checkTimeoutSeconds * 1000,
        signal,
        maxRedirects: 0,
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
    const reason = controller.signal.aborted ? 'TimeoutError' : (error?.code || error?.name || error?.message || 'Error');
    return { proxy, alive: false, latency: null, error: reason };
  } finally {
    clearTimeout(deadline);
  }
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index]);
      } catch (error) {
        results[index] = {
          proxy: values[index], alive: false, latency: null,
          error: `Unexpected:${error?.name || 'Error'}`,
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function checkAll(db, { aliveOnly = false, staleOnly = false } = {}) {
  let proxies = db.candidates({ aliveOnly, staleOnly });
  if (settings.maxCandidatesPerCycle > 0) proxies = proxies.slice(0, settings.maxCandidatesPerCycle);
  const errorTypes = {};
  let failed = 0;
  let unexpected = 0;
  const batchSize = Math.max(settings.checkConcurrency, settings.checkPersistBatchSize);

  for (let offset = 0; offset < proxies.length; offset += batchSize) {
    const batch = proxies.slice(offset, offset + batchSize);
    const results = await mapConcurrent(batch, settings.checkConcurrency, checkOne);
    const checks = [];
    for (const result of results) {
      if (!result.alive) {
        failed += 1;
        if (result.error) errorTypes[result.error] = (errorTypes[result.error] || 0) + 1;
        checks.push([result.proxy, false, null]);
      } else {
        checks.push([result.proxy, true, result.latency]);
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
  return { tested: proxies.length, failed, unexpected, errorTypes };
}
