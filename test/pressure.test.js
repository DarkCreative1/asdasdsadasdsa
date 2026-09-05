import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../src/db.js';
import { checkAll } from '../src/checker.js';
import { NetworkGuard, errorCode } from '../src/network.js';
import { settings } from '../src/config.js';

test('resource errors are extracted from Axios causes and SOCKS messages', () => {
  assert.equal(errorCode({ code: 'ERR_NETWORK', cause: { code: 'ENOBUFS' } }), 'ENOBUFS');
  assert.equal(errorCode(new Error('connect ENOBUFS 127.0.0.1:1080')), 'ENOBUFS');
});

test('host exhaustion pauses checks, preserves evidence and automatically recovers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pressure-'));
  const db = await Database.open(path.join(dir, 'test.db'));
  const saved = { ...settings };
  settings.checkConcurrency = 1;
  settings.maxCandidatesPerCycle = 0;
  let now = 1000;
  const guard = new NetworkGuard(() => now);
  const proxy = 'http://127.0.0.1:8800';
  try {
    db.addMany(new Set([proxy, 'http://127.0.0.1:8801']), 'test');
    db.updateCheck(proxy, true, 10);
    db.updateCheck(proxy, true, 10);
    const before = db.queryOne('SELECT * FROM proxies WHERE proxy=?', [proxy]);
    let calls = 0;
    const checker = async (url) => { calls++; return { proxy: url, alive: false, error: 'ENOBUFS' }; };
    const result = await checkAll(db, { checker, guard });
    assert.equal(calls, 1);
    assert.equal(result.tested, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.deferred, 1);
    assert.equal(result.skipped, 1);
    assert.deepEqual(db.queryOne('SELECT * FROM proxies WHERE proxy=?', [proxy]), before);
    await checkAll(db, { checker, guard });
    assert.equal(calls, 1, 'no new sockets while paused');
    now += 30001;
    const recovered = await checkAll(db, { guard, checker: async (url) => ({ proxy: url, alive: true, latency: 10 }) });
    assert.equal(recovered.succeeded, 2);
    assert.equal(guard.paused(), false);
    assert.ok(db.healthy().includes(proxy));
    const old = new Date(Date.now() - (settings.staleAfterSeconds + 5) * 1000).toISOString();
    db.db.run('UPDATE proxies SET last_checked=?', [old]);
    assert.deepEqual(db.healthy(), [], 'expired evidence is never advertised during cooldown');
    assert.equal(db.stats().stable, 0);
    assert.deepEqual(db.protocolCounts(), {});
    assert.deepEqual(db.healthyProtocol('http'), []);
  } finally {
    Object.assign(settings, saved);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resource cooldown backs off, limits concurrency and recovers gradually', () => {
  let now = 1;
  const guard = new NetworkGuard(() => now);
  guard.fail('ENOBUFS', 100);
  assert.equal(guard.concurrency(100), 50);
  guard.fail('ENOBUFS', 100);
  assert.equal(guard.status(100).retry_in_seconds, 30);
  now += 30001;
  guard.fail('ENOBUFS', 100);
  assert.equal(guard.concurrency(100), 25);
  assert.equal(guard.status(100).retry_in_seconds, 60);
  now += 60001;
  guard.succeeded(100);
  assert.equal(guard.concurrency(100), 26);
});
