import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../src/db.js';
import { checkAll, checkOne } from '../src/checker.js';
import { parseSourceText } from '../src/sources.js';
import { settings } from '../src/config.js';

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-test-'));
  return { dir, db: new Database(path.join(dir, 'test.db')) };
}

test('source parser normalizes supported protocols and rejects bad ports', () => {
  const source = ['test', 'https://example.invalid', 'socks5'];
  const parsed = parseSourceText(source, '1.2.3.4:1080\nhttp://5.6.7.8:8080\n9.9.9.9:70000');
  assert.deepEqual([...parsed], ['socks5://1.2.3.4:1080', 'socks5://5.6.7.8:8080']);
});

test('broken SOCKS proxies become dead without rejecting the batch', async () => {
  const { dir, db } = makeDb();
  const oldLimit = settings.maxCandidatesPerCycle;
  try {
    const values = new Set(['socks4://127.0.0.1:1', 'socks5://127.0.0.1:1', 'http://127.0.0.1:1']);
    db.addMany(values, 'test');
    settings.maxCandidatesPerCycle = 0;
    const result = await checkAll(db);
    assert.equal(result.tested, 3);
    assert.equal(result.unexpected, 0);
    assert.equal(db.stats().alive_latest, 0);
  } finally {
    settings.maxCandidatesPerCycle = oldLimit;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('single proxy timeout is converted to a failed result', async () => {
  const oldTimeout = settings.checkTimeoutSeconds;
  settings.checkTimeoutSeconds = 0.05;
  try {
    const result = await checkOne('socks5://127.0.0.1:1');
    assert.equal(result.alive, false);
    assert.equal(typeof result.error, 'string');
  } finally {
    settings.checkTimeoutSeconds = oldTimeout;
  }
});

test('a proxy needs two successful checks before it is stable', () => {
  const { dir, db } = makeDb();
  try {
    const proxy = 'http://127.0.0.1:8080';
    db.addMany(new Set([proxy]), 'test');
    db.updateCheck(proxy, true, 10);
    assert.deepEqual(db.healthy(), []);
    db.updateCheck(proxy, true, 10);
    assert.deepEqual(db.healthy(), [proxy]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
