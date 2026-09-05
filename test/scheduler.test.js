import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { settings } from '../src/config.js';
import { CheckScheduler } from '../src/scheduler.js';
import { PoolWorker } from '../src/worker.js';
import { Database } from '../src/db.js';
import { checkAll } from '../src/checker.js';
import { NetworkGuard } from '../src/network.js';

async function waitFor(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await delay(5);
  }
}

test('live work wins the next shared slot; duplicate and cancelled work never starts', async () => {
  const previous = settings.checkConcurrency;
  settings.checkConcurrency = 1;
  const scheduler = new CheckScheduler(new NetworkGuard());
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = scheduler.run('first', async () => { order.push('first'); await gate; });
  try {
    await waitFor(() => scheduler.active === 1);
    assert.equal(await scheduler.run('first', () => assert.fail('duplicate ran')), null);
    const discovery = scheduler.run('discovery', async () => order.push('discovery'));
    const live = scheduler.run('live', async () => order.push('live'), { priority: 1 });
    const controller = new AbortController();
    const cancelled = scheduler.run('cancelled', () => assert.fail('cancelled ran'), { signal: controller.signal });
    controller.abort();
    release();
    await Promise.all([first, discovery, live, cancelled]);
    assert.deepEqual(order, ['first', 'live', 'discovery']);
    assert.deepEqual(scheduler.status(), { active: 0, queued: 0, in_flight: 0 });
  } finally { release(); await first; settings.checkConcurrency = previous; }
});

test('live pool stays fresh during slow discovery AND a blocked source fetch; stop drains work', { timeout: 6000 }, async () => {
  const saved = { ...settings };
  Object.assign(settings, { checkConcurrency: 2, checkIntervalSeconds: 0.02,
    staleAfterSeconds: 0.25, maxCandidatesPerCycle: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-worker-'));
  const db = await Database.open(path.join(dir, 'test.db'));
  const liveProxy = 'http://127.0.0.1:8000';
  let active = 0;
  let peak = 0;
  let liveChecks = 0;
  let discoveryChecks = 0;
  let sourceEnded = false;
  let cancelled = 0;
  const worker = new PoolWorker(db, {
    guard: new NetworkGuard(),
    fetcher: async ({ signal }) => {
      try { await delay(5000, undefined, { signal }); return []; }
      finally { sourceEnded = true; }
    },
    checker: async (proxy, { signal }) => {
      active++; peak = Math.max(peak, active);
      try {
        if (proxy === liveProxy) {
          liveChecks++;
          return { alive: true, latency: 1 };
        }
        await delay(35, undefined, { signal });
        discoveryChecks++;
        return { alive: false, error: 'TimeoutError' };
      } catch {
        cancelled++;
        return { alive: false, cancelled: true };
      } finally { active--; }
    },
  });
  try {
    db.addMany(new Set([liveProxy, ...Array.from({ length: 80 }, (_, i) => `http://127.0.0.1:${8100 + i}`)]), 'test');
    db.updateChecks([[liveProxy, true, 1], [liveProxy, true, 1]]);
    worker.start();
    await waitFor(() => liveChecks >= 8);
    assert.equal(sourceEnded, false);
    assert.ok(discoveryChecks > 0 && discoveryChecks < 80);
    assert.deepEqual(db.healthy(), [liveProxy]);
    assert.ok(peak <= 2, 'live + discovery must share a global budget');
    const before = Date.now();
    await worker.stop();
    assert.ok(Date.now() - before < 1000);
    assert.equal(sourceEnded, true);
    assert.equal(active, 0);
    assert.ok(cancelled > 0);
    assert.deepEqual(worker.scheduler.status(), { active: 0, queued: 0, in_flight: 0 });
    assert.equal(getEventListeners(worker.controller.signal, 'abort').length, 0);
    assert.deepEqual(worker.errors, {});
    assert.equal(db.dirty, false);
  } finally {
    await worker.stop(); db.close();
    Object.assign(settings, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('results are published before a slow discovery tail completes and old writes cannot overwrite newer evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-stream-'));
  const db = await Database.open(path.join(dir, 'test.db'));
  const saved = { ...settings };
  Object.assign(settings, { checkConcurrency: 2, maxCandidatesPerCycle: 0 });
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  let published = false;
  let scan;
  try {
    const fast = 'http://127.0.0.1:9000';
    const slow = 'http://127.0.0.1:9001';
    db.addMany(new Set([fast, slow]), 'test');
    scan = checkAll(db, { checker: async (proxy) => {
      if (proxy === slow) await gate;
      else published = true;
      return { alive: true, latency: 1 };
    } });
    await waitFor(() => published && db.stats().alive_latest === 1);
    assert.equal(db.queryOne('SELECT check_count FROM proxies WHERE proxy=?', [slow]).check_count, 0);
    finish(); await scan;
    const before = db.queryOne('SELECT * FROM proxies WHERE proxy=?', [fast]);
    db.updateChecks([[fast, false, null, '2000-01-01T00:00:00.000Z']]);
    assert.deepEqual(db.queryOne('SELECT * FROM proxies WHERE proxy=?', [fast]), before);
  } finally {
    finish(); if (scan) await scan;
    db.close(); Object.assign(settings, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent manual source refreshes share one fetch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-refresh-'));
  const db = await Database.open(path.join(dir, 'test.db'));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let fetches = 0;
  const worker = new PoolWorker(db, { fetcher: async () => {
    fetches++; await gate;
    return [{ source: ['test'], result: { status: 'fulfilled', value: new Set(['http://127.0.0.1:9876']) } }];
  } });
  try {
    const first = worker.refresh();
    const second = worker.refresh();
    assert.equal(fetches, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(a.unique_candidates, 1);
    assert.equal(db.stats().total, 1);
  } finally {
    release(); await worker.stop(); db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
