import axios from 'axios';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { settings } from './config.js';
import { errorCode, errorDetail, isResourceError, networkGuard } from './network.js';

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
      if (response.status !== 204) throw Object.assign(new Error(`Expected 204, received HTTP ${response.status}`), { code: `HTTP_STATUS_${response.status}` });
    }
    return true;
  } finally {
    agents.httpAgent?.destroy?.();
    if (agents.httpsAgent !== agents.httpAgent) agents.httpsAgent?.destroy?.();
  }
}

export async function checkOne(proxy, { signal } = {}) {
  const started = performance.now();
  const timeoutMs = settings.checkTimeoutSeconds * 1000;
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  deadline.unref?.();
  try {
    combinedSignal.throwIfAborted();
    const passed = await probe(proxy, combinedSignal);
    const latency = Math.round((performance.now() - started) * 100) / 100;
    const alive = passed && latency <= timeoutMs;
    return { proxy, alive, latency: alive ? latency : null, error: alive ? null : 'TimeoutError' };
  } catch (error) {
    if (signal?.aborted) return { proxy, alive: false, latency: null, error: 'CANCELLED', cancelled: true };
    const code = errorCode(error);
    const reason = isResourceError(code) ? code : (controller.signal.aborted ? 'TimeoutError' : code);
    return { proxy, alive: false, latency: null, error: reason, detail: errorDetail(error) };
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}

export async function checkAll(db, { aliveOnly = false, staleOnly = false,
  knownOnly = false, discoveryOnly = false, dueSeconds = settings.staleAfterSeconds,
  checker = checkOne, guard = networkGuard, scheduler, signal, persist = true } = {}) {
  const started = performance.now();
  let proxies = db.candidates({ aliveOnly, staleOnly, knownOnly, discoveryOnly, dueSeconds });
  // A discovery cap must never exclude already-working proxies from rechecks.
  if (!knownOnly && !aliveOnly && settings.maxCandidatesPerCycle > 0) proxies = proxies.slice(0, settings.maxCandidatesPerCycle);
  const summary = { tested: 0, failed: 0, succeeded: 0, deferred: 0, skipped: 0,
    unexpected: 0, errorTypes: {}, errorSamples: {} };
  let next = 0;
  let sinceSave = 0;
  const recordError = (code, detail) => {
    const key = Object.hasOwn(summary.errorTypes, code) || Object.keys(summary.errorTypes).length < 40 ? code : 'OTHER';
    summary.errorTypes[key] = (summary.errorTypes[key] || 0) + 1;
    if (detail && !summary.errorSamples[key]) summary.errorSamples[key] = detail;
  };
  const flush = () => {
    if (!persist || !db.dirty) return;
    try { db.save(); sinceSave = 0; }
    catch (error) { summary.unexpected++; recordError(`database:${errorCode(error)}`, errorDetail(error)); }
  };
  const run = async (proxy) => {
    // The discovery snapshot may be minutes old by the time a slot is free.
    if (knownOnly || discoveryOnly) {
      const row = db.queryOne('SELECT last_success FROM proxies WHERE proxy=?', [proxy]);
      if (!row || (knownOnly && !row.last_success) || (discoveryOnly && row.last_success)) return;
    }
    let result;
    try { result = await checker(proxy, { signal }); }
    catch (error) { result = { alive: false, error: errorCode(error), detail: errorDetail(error) }; }
    summary.tested++;
    if (result.cancelled || signal?.aborted) { summary.deferred++; return; }
    guard.fail(result.error, settings.checkConcurrency);
    if (result.error) recordError(result.error, result.detail);
    if (!result.alive && guard.paused()) { summary.deferred++; return; }
    summary[result.alive ? 'succeeded' : 'failed']++;
    try {
      // Publish each completion immediately. Disk exports are coalesced by the
      // service's flush loop (or every configured batch for snapshot scripts).
      db.updateChecks([[proxy, result.alive, result.latency ?? null, new Date().toISOString()]], { persist: false });
      sinceSave++;
    } catch (error) { summary.unexpected++; recordError(`database:${errorCode(error)}`, errorDetail(error)); }
    if (sinceSave >= settings.checkPersistBatchSize) flush();
  };
  const worker = async () => {
    while (!signal?.aborted && !guard.paused()) {
      const proxy = proxies[next++];
      if (proxy === undefined) return;
      if (scheduler) await scheduler.run(proxy, () => run(proxy), { priority: knownOnly ? 1 : 0, signal });
      else await run(proxy);
    }
  };
  await Promise.all(Array.from({ length: Math.min(guard.concurrency(settings.checkConcurrency), proxies.length) }, worker));
  flush();
  if (summary.succeeded > 0 && !guard.paused()) guard.succeeded(settings.checkConcurrency);
  summary.skipped = proxies.length - summary.tested;
  summary.duration_ms = Math.round(performance.now() - started);
  return summary;
}
