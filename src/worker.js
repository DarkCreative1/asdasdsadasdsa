import { setTimeout as delay } from 'node:timers/promises';
import { setMaxListeners } from 'node:events';
import { settings } from './config.js';
import { checkAll, checkOne } from './checker.js';
import { fetchAllSources } from './sources.js';
import { networkGuard, errorCode, errorDetail } from './network.js';
import { CheckScheduler } from './scheduler.js';

export class PoolWorker {
  constructor(db, { checker = checkOne, fetcher = fetchAllSources,
    guard = networkGuard, logger = () => {} } = {}) {
    this.db = db;
    this.checker = checker;
    this.fetcher = fetcher;
    this.guard = guard;
    this.logger = logger;
    this.scheduler = new CheckScheduler(guard);
    this.controller = new AbortController();
    // A bounded set of queued checks shares this cancellation signal.
    setMaxListeners(0, this.controller.signal);
    this.tasks = [];
    this.cycles = {};
    this.errors = {};
    this.active = {};
    this.lastRefresh = null;
    this.sourcePromise = null;
  }

  get running() { return this.tasks.length > 0 && !this.controller.signal.aborted; }

  start() {
    if (this.tasks.length) return;
    this.tasks = [
      this.loop('sources', () => this.refresh(), () => settings.fetchIntervalSeconds),
      this.loop('live', () => this.scan(true), () => this.liveInterval()),
      this.loop('discovery', () => this.scan(false), () => settings.checkIntervalSeconds),
      this.loop('flush', () => { if (this.db.dirty) this.db.save(); }, () => 1),
    ];
  }

  liveInterval() {
    return Math.min(settings.checkIntervalSeconds, settings.staleAfterSeconds / 2);
  }

  async loop(name, task, interval) {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      const started = performance.now();
      try {
        if (name === 'flush' || !this.guard.paused()) {
          this.active[name] = true;
          await task();
          delete this.errors[name];
        }
      } catch (error) {
        if (!signal.aborted) {
          this.errors[name] = { at: new Date().toISOString(), code: errorCode(error), detail: errorDetail(error) };
          this.logger('error', { lane: name, ...this.errors[name] });
        }
      } finally { this.active[name] = false; }
      if (signal.aborted) break;
      try {
        const waitMs = this.guard.paused() && name !== 'flush' ? 1000 :
          Math.max(1, interval() * 1000 - (performance.now() - started));
        await delay(waitMs, undefined, { signal });
      } catch (error) { if (!signal.aborted) throw error; }
    }
  }

  async refresh() {
    if (this.controller.signal.aborted) throw new Error('Worker stopped');
    if (this.sourcePromise) return this.sourcePromise;
    this.sourcePromise = this.collectSources();
    try { return await this.sourcePromise; }
    finally { this.sourcePromise = null; }
  }

  async collectSources() {
    const signal = this.controller.signal;
    const results = await this.fetcher({ signal });
    signal.throwIfAborted();
    let candidates = 0;
    const unique = new Set();
    const sources = {};
    const errors = {};
    for (const { source, result } of results) {
      if (result.status === 'fulfilled') {
        this.db.addMany(result.value, source[0], { persist: false });
        sources[source[0]] = result.value.size;
        candidates += result.value.size;
        for (const proxy of result.value) unique.add(proxy);
      } else {
        sources[source[0]] = 0;
        errors[source[0]] = { code: errorCode(result.reason), detail: errorDetail(result.reason) };
      }
    }
    this.lastRefresh = new Date().toISOString();
    const summary = { at: this.lastRefresh, candidates, unique_candidates: unique.size, sources, errors };
    this.cycles.sources = summary;
    this.logger('sources', summary);
    return summary;
  }

  async scan(live) {
    const lane = live ? 'live' : 'discovery';
    const summary = await checkAll(this.db, {
      knownOnly: live, discoveryOnly: !live, staleOnly: !live,
      dueSeconds: live ? this.liveInterval() : settings.staleAfterSeconds,
      scheduler: this.scheduler, checker: this.checker, guard: this.guard,
      signal: this.controller.signal, persist: false,
    });
    if (!live && !this.controller.signal.aborted) {
      this.db.prune([...this.scheduler.inFlight], { persist: false });
    }
    this.cycles[lane] = { at: new Date().toISOString(), ...summary };
    if (!this.controller.signal.aborted) this.logger(lane, this.cycles[lane]);
    if (summary.unexpected > 0 && !this.controller.signal.aborted) {
      throw Object.assign(new Error(`${summary.unexpected} database update errors; see ${lane} cycle diagnostics`), { code: 'CHECK_STORAGE_ERROR' });
    }
    return summary;
  }

  status() {
    return { running: this.running, active: { ...this.active }, scheduler: this.scheduler.status(),
      last_refresh: this.lastRefresh, cycles: this.cycles, errors: this.errors };
  }

  async stop() {
    this.controller.abort();
    await Promise.allSettled([...this.tasks, this.sourcePromise].filter(Boolean));
    if (this.db.dirty) this.db.save();
  }
}
