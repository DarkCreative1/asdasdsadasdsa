import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { settings } from './config.js';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');

const updateSql = `UPDATE proxies SET alive=?, latency_ms=?, last_checked=?, check_count=check_count+1,
  successes=successes+?, failures=failures+?, success_rate=CAST(successes+? AS REAL)/(check_count+1),
  recent_successes=CASE WHEN recent_checks < ? THEN recent_successes+?
    ELSE recent_successes+?-((recent_results >> (?-1)) & 1) END,
  recent_checks=MIN(recent_checks+1, ?), recent_results=((recent_results << 1) | ?) & ?,
  last_success=CASE WHEN ? THEN ? ELSE last_success END WHERE proxy=?
  AND (last_checked IS NULL OR last_checked<=?)`;

export class Database {
  static async open(databasePath = settings.databasePath) {
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    return new Database(databasePath, SQL);
  }

  constructor(databasePath, SQL) {
    fs.mkdirSync(path.dirname(databasePath) || '.', { recursive: true });
    this.path = databasePath;
    const bytes = fs.existsSync(databasePath) ? fs.readFileSync(databasePath) : null;
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.db.run(`CREATE TABLE IF NOT EXISTS proxies (
      proxy TEXT PRIMARY KEY, protocol TEXT NOT NULL, alive INTEGER DEFAULT 0,
      latency_ms REAL, successes INTEGER DEFAULT 0, failures INTEGER DEFAULT 0,
      last_checked TEXT, last_success TEXT, source TEXT, created_at TEXT NOT NULL,
      check_count INTEGER DEFAULT 0, success_rate REAL DEFAULT 0,
      recent_results INTEGER DEFAULT 0, recent_checks INTEGER DEFAULT 0,
      recent_successes INTEGER DEFAULT 0
    )`);
    this.migrate();
    this.save();
  }

  migrate() {
    const columns = new Set(this.queryAll('PRAGMA table_info(proxies)').map((column) => column.name));
    const additions = [
      ['recent_results', 'INTEGER DEFAULT 0'],
      ['recent_checks', 'INTEGER DEFAULT 0'],
      ['recent_successes', 'INTEGER DEFAULT 0'],
    ];
    let migrated = false;
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.db.run(`ALTER TABLE proxies ADD COLUMN ${name} ${definition}`);
        migrated = true;
      }
    }
    if (migrated) {
      // Require fresh evidence after upgrading, while preserving one current result.
      this.db.run(`UPDATE proxies SET
        recent_results=CASE WHEN alive=1 THEN 1 ELSE 0 END,
        recent_checks=CASE WHEN last_checked IS NULL THEN 0 ELSE 1 END,
        recent_successes=CASE WHEN alive=1 THEN 1 ELSE 0 END`);
    }
    this.db.run('CREATE TABLE IF NOT EXISTS pool_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    const previousWindow = this.queryOne("SELECT value FROM pool_metadata WHERE key='stability_window'");
    if (!previousWindow || previousWindow.value !== settings.minChecks) {
      // Bits from a different-sized window cannot be used with the new divisor.
      // Keep lifetime statistics and known-proxy membership, require new checks.
      this.db.run('UPDATE proxies SET recent_results=0, recent_checks=0, recent_successes=0');
      this.db.run("INSERT INTO pool_metadata VALUES ('stability_window', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [settings.minChecks]);
    }
  }

  save() {
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    let file;
    try {
      file = fs.openSync(temporaryPath, 'w');
      fs.writeFileSync(file, Buffer.from(this.db.export()));
      fs.fsyncSync(file);
      fs.closeSync(file);
      file = undefined;
      fs.renameSync(temporaryPath, this.path);
      this.dirty = false;
    } finally {
      if (file !== undefined) fs.closeSync(file);
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }

  queryAll(sql, params = []) {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }

  queryOne(sql, params = []) {
    return this.queryAll(sql, params)[0] || null;
  }

  addMany(proxies, source, { persist = true } = {}) {
    if (!proxies.size) return;
    const statement = this.db.prepare(`INSERT INTO proxies(proxy, protocol, source, created_at)
      VALUES(?,?,?,?) ON CONFLICT(proxy) DO UPDATE SET source=excluded.source`);
    const createdAt = new Date().toISOString();
    try {
      for (const proxy of proxies) {
        statement.run([proxy, proxy.split(':', 1)[0], source, createdAt]);
        statement.reset();
      }
    } finally {
      statement.free();
    }
    this.dirty = true;
    if (persist) this.save();
  }

  updateCheck(proxy, alive, latency) {
    this.updateChecks([[proxy, alive, latency]]);
  }

  updateChecks(checks, { persist = true } = {}) {
    if (!checks.length) return;
    const statement = this.db.prepare(updateSql);
    const checkedAt = new Date().toISOString();
    this.db.run('BEGIN TRANSACTION');
    try {
      for (const [proxy, alive, latency, completedAt = checkedAt] of checks) {
        const flag = alive ? 1 : 0;
        const windowSize = settings.minChecks;
        const windowMask = (2 ** windowSize) - 1;
        statement.run([
          flag, latency, completedAt, flag, alive ? 0 : 1, flag,
          windowSize, flag, flag, windowSize, windowSize, flag, windowMask,
          flag, completedAt, proxy, completedAt,
        ]);
        statement.reset();
      }
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    } finally {
      statement.free();
    }
    this.dirty = true;
    if (persist) this.save();
  }

  candidates({ aliveOnly = false, staleOnly = false, knownOnly = false,
    discoveryOnly = false, dueSeconds = settings.staleAfterSeconds } = {}) {
    const conditions = [];
    const params = [];
    if (aliveOnly) conditions.push('alive=1');
    if (knownOnly) conditions.push('last_success IS NOT NULL');
    if (discoveryOnly) conditions.push('last_success IS NULL');
    if (staleOnly) {
      const cutoff = new Date(Date.now() - dueSeconds * 1000).toISOString();
      conditions.push('(last_checked IS NULL OR last_checked <= ?)');
      params.push(cutoff);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.queryAll(`SELECT proxy FROM proxies ${where}
      ORDER BY last_checked ASC, alive DESC, success_rate DESC,
        CASE WHEN source LIKE 'monosans-%' THEN 0
             WHEN source LIKE 'proxifly-%' THEN 1
             WHEN source LIKE 'iplocate-%' THEN 2 ELSE 3 END,
        latency_ms ASC`, params).map((row) => row.proxy);
  }

  healthy(limit = 500) {
    return this.queryAll(`SELECT proxy FROM proxies WHERE alive=1 AND recent_checks>=?
      AND CAST(recent_successes AS REAL)/recent_checks>=? AND last_checked>=?
      ORDER BY latency_ms ASC LIMIT ?`, [settings.minChecks, settings.minSuccessRate, this.freshnessCutoff(), limit])
      .map((row) => row.proxy);
  }

  healthyProtocol(protocol, limit = 500) {
    return this.queryAll(`SELECT proxy FROM proxies WHERE protocol=? AND alive=1
      AND recent_checks>=? AND CAST(recent_successes AS REAL)/recent_checks>=?
      AND last_checked>=? ORDER BY latency_ms ASC LIMIT ?`, [protocol, settings.minChecks, settings.minSuccessRate, this.freshnessCutoff(), limit])
      .map((row) => row.proxy);
  }

  stats() {
    const row = this.queryOne(`SELECT COUNT(*) AS total, COALESCE(SUM(alive),0) AS alive,
      COALESCE(SUM(CASE WHEN alive=1 AND recent_checks>=?
        AND CAST(recent_successes AS REAL)/recent_checks>=? AND last_checked>=? THEN 1 ELSE 0 END),0) AS stable,
      COALESCE(AVG(CASE WHEN alive=1 THEN latency_ms END),0) AS latency FROM proxies`, [settings.minChecks, settings.minSuccessRate, this.freshnessCutoff()]);
    const bySource = Object.fromEntries(this.queryAll('SELECT source, COUNT(*) AS count FROM proxies GROUP BY source').map((item) => [item.source, item.count]));
    return { total: row.total, healthy: row.stable, stable: row.stable, alive_latest: row.alive, average_latency_ms: Math.round(row.latency * 100) / 100, by_source: bySource };
  }

  protocolCounts() {
    return Object.fromEntries(this.queryAll(`SELECT UPPER(protocol) AS protocol, COUNT(*) AS count
      FROM proxies WHERE alive=1 AND recent_checks>=?
        AND CAST(recent_successes AS REAL)/recent_checks>=? AND last_checked>=?
        GROUP BY protocol`, [settings.minChecks, settings.minSuccessRate, this.freshnessCutoff()])
      .map((item) => [item.protocol, item.count]));
  }

  freshnessCutoff() {
    return new Date(Date.now() - settings.staleAfterSeconds * 1000).toISOString();
  }

  prune(excluded = [], { persist = true } = {}) {
    const exclusion = excluded.length ? `AND proxy NOT IN (${excluded.map(() => '?').join(',')})` : '';
    this.db.run(`DELETE FROM proxies WHERE ((last_checked IS NOT NULL AND last_success IS NULL)
      OR (alive=0 AND recent_checks>=? AND recent_successes=0)) ${exclusion}`, [settings.minChecks, ...excluded]);
    const changes = this.db.getRowsModified();
    if (changes > 0) { this.dirty = true; if (persist) this.save(); }
    return changes;
  }

  close() {
    this.save();
    this.db.close();
  }
}
