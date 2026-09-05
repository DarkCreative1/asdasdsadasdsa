import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { Database } from '../src/db.js';
import { checkAll, checkOne } from '../src/checker.js';
import { parseSourceText } from '../src/sources.js';
import { settings } from '../src/config.js';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');

async function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-test-'));
  return { dir, db: await Database.open(path.join(dir, 'test.db')) };
}

test('source parser normalizes supported protocols and rejects bad ports', () => {
  const source = ['test', 'https://example.invalid', 'socks5'];
  const parsed = parseSourceText(source, '1.2.3.4:1080\nhttp://5.6.7.8:8080\n9.9.9.9:70000');
  assert.deepEqual([...parsed], ['socks5://1.2.3.4:1080', 'socks5://5.6.7.8:8080']);
});

test('broken SOCKS proxies become dead without rejecting the batch', async () => {
  const { dir, db } = await makeDb();
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

test('a proxy needs two successful checks before it is stable', async () => {
  const { dir, db } = await makeDb();
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

test('a proxy recovers after a temporary failure without resetting lifetime statistics', async () => {
  const { dir, db } = await makeDb();
  try {
    const proxy = 'http://127.0.0.1:8081';
    db.addMany(new Set([proxy]), 'test');
    db.updateCheck(proxy, true, 10);
    db.updateCheck(proxy, true, 10);
    assert.deepEqual(db.healthy(), [proxy]);

    db.updateCheck(proxy, false, null);
    assert.deepEqual(db.healthy(), []);
    db.updateCheck(proxy, true, 10);
    assert.deepEqual(db.healthy(), []);
    db.updateCheck(proxy, true, 10);
    assert.deepEqual(db.healthy(), [proxy]);

    const record = db.queryOne('SELECT successes, failures, success_rate FROM proxies WHERE proxy=?', [proxy]);
    assert.deepEqual({ successes: record.successes, failures: record.failures }, { successes: 4, failures: 1 });
    assert.ok(record.success_rate < 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prune reports deleted rows and persists the deletion', async () => {
  const { dir, db } = await makeDb();
  const databasePath = path.join(dir, 'test.db');
  try {
    const proxy = 'http://127.0.0.1:8082';
    db.addMany(new Set([proxy]), 'test');
    db.updateCheck(proxy, false, null);
    assert.equal(db.prune(), 1);
    assert.equal(db.stats().total, 0);
  } finally {
    db.close();
  }

  const reopened = await Database.open(databasePath);
  try {
    assert.equal(reopened.stats().total, 0);
  } finally {
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing database is migrated and can recover normally', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-legacy-'));
  const databasePath = path.join(dir, 'legacy.db');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const legacy = new SQL.Database();
  legacy.run(`CREATE TABLE proxies (
    proxy TEXT PRIMARY KEY, protocol TEXT NOT NULL, alive INTEGER DEFAULT 0,
    latency_ms REAL, successes INTEGER DEFAULT 0, failures INTEGER DEFAULT 0,
    last_checked TEXT, last_success TEXT, source TEXT, created_at TEXT NOT NULL,
    check_count INTEGER DEFAULT 0, success_rate REAL DEFAULT 0
  )`);
  legacy.run(`INSERT INTO proxies VALUES (
    'http://127.0.0.1:8083', 'http', 0, NULL, 10, 1,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'legacy',
    '2026-01-01T00:00:00.000Z', 11, 0.909
  )`);
  fs.writeFileSync(databasePath, Buffer.from(legacy.export()));
  legacy.close();

  const db = await Database.open(databasePath);
  try {
    assert.deepEqual(db.healthy(), []);
    db.updateCheck('http://127.0.0.1:8083', true, 10);
    assert.deepEqual(db.healthy(), []);
    db.updateCheck('http://127.0.0.1:8083', true, 10);
    assert.deepEqual(db.healthy(), ['http://127.0.0.1:8083']);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5400 recorded outcomes with intermittent failures do not permanently poison a proxy', async () => {
  const { dir, db } = await makeDb();
  try {
    const proxy = 'http://127.0.0.1:8084';
    db.addMany(new Set([proxy]), 'endurance');
    const minuteChecks = Array.from({ length: 90 * 60 }, (_, minute) => {
      const alive = minute % 503 !== 250;
      return [proxy, alive, alive ? 10 : null];
    });
    db.updateChecks(minuteChecks);
    const record = db.queryOne(`SELECT check_count, failures, success_rate,
      recent_checks, recent_successes FROM proxies WHERE proxy=?`, [proxy]);
    assert.equal(record.check_count, 5400);
    assert.ok(record.failures > 0);
    assert.ok(record.success_rate < 1);
    assert.equal(record.recent_checks, settings.minChecks);
    assert.equal(record.recent_successes, settings.minChecks);
    assert.deepEqual(db.healthy(), [proxy]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('changing MIN_CHECKS across restarts cannot reuse incompatible window counters', async () => {
  const previous = settings.minChecks;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-window-'));
  const dbPath = path.join(dir, 'test.db');
  let db;
  try {
    settings.minChecks = 3;
    db = await Database.open(dbPath);
    const proxy = 'http://127.0.0.1:9876';
    db.addMany(new Set([proxy]), 'test');
    db.updateChecks([[proxy, true, 1], [proxy, true, 1], [proxy, true, 1]]);
    assert.deepEqual(db.healthy(), [proxy]);
    db.close(); db = null;
    settings.minChecks = 2;
    db = await Database.open(dbPath);
    assert.deepEqual(db.healthy(), []);
    db.updateCheck(proxy, true, 1);
    assert.deepEqual(db.healthy(), []);
    db.updateCheck(proxy, true, 1);
    assert.deepEqual(db.healthy(), [proxy]);
    assert.equal(db.queryOne('SELECT successes FROM proxies WHERE proxy=?', [proxy]).successes, 5);
  } finally {
    db?.close(); settings.minChecks = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
