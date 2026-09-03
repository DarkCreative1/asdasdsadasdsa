import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { settings } from './config.js';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');

const updateSql = `UPDATE proxies SET alive=?, latency_ms=?, last_checked=?, check_count=check_count+1,
  successes=successes+?, failures=failures+?, success_rate=CAST(successes+? AS REAL)/(check_count+1),
  last_success=CASE WHEN ? THEN ? ELSE last_success END WHERE proxy=?`;

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
      check_count INTEGER DEFAULT 0, success_rate REAL DEFAULT 0
    )`);
    this.save();
  }

  save() {
    fs.writeFileSync(this.path, Buffer.from(this.db.export()));
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

  addMany(proxies, source) {
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
    this.save();
  }

  updateCheck(proxy, alive, latency) {
    this.updateChecks([[proxy, alive, latency]]);
  }

  updateChecks(checks) {
    if (!checks.length) return;
    const statement = this.db.prepare(updateSql);
    const checkedAt = new Date().toISOString();
    this.db.run('BEGIN TRANSACTION');
    try {
      for (const [proxy, alive, latency] of checks) {
        const flag = alive ? 1 : 0;
        statement.run([flag, latency, checkedAt, flag, alive ? 0 : 1, flag, flag, checkedAt, proxy]);
        statement.reset();
      }
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    } finally {
      statement.free();
    }
    this.save();
  }

  candidates({ aliveOnly = false, staleOnly = false } = {}) {
    const conditions = [];
    const params = [];
    if (aliveOnly) conditions.push('alive=1');
    if (staleOnly) {
      const cutoff = new Date(Date.now() - settings.staleAfterSeconds * 1000).toISOString();
      conditions.push('(last_checked IS NULL OR last_checked <= ?)');
      params.push(cutoff);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.queryAll(`SELECT proxy FROM proxies ${where}
      ORDER BY alive DESC, success_rate DESC,
        CASE WHEN source LIKE 'monosans-%' THEN 0
             WHEN source LIKE 'proxifly-%' THEN 1
             WHEN source LIKE 'iplocate-%' THEN 2 ELSE 3 END,
        latency_ms ASC`, params).map((row) => row.proxy);
  }

  healthy(limit = 500) {
    return this.queryAll(`SELECT proxy FROM proxies WHERE alive=1 AND check_count>=?
      AND success_rate>=? ORDER BY latency_ms ASC LIMIT ?`, [settings.minChecks, settings.minSuccessRate, limit])
      .map((row) => row.proxy);
  }

  healthyProtocol(protocol, limit = 500) {
    return this.queryAll(`SELECT proxy FROM proxies WHERE protocol=? AND alive=1
      AND check_count>=? AND success_rate>=? ORDER BY latency_ms ASC LIMIT ?`, [protocol, settings.minChecks, settings.minSuccessRate, limit])
      .map((row) => row.proxy);
  }

  stats() {
    const row = this.queryOne(`SELECT COUNT(*) AS total, COALESCE(SUM(alive),0) AS alive,
      COALESCE(SUM(CASE WHEN alive=1 AND check_count>=? AND success_rate>=? THEN 1 ELSE 0 END),0) AS stable,
      COALESCE(AVG(CASE WHEN alive=1 THEN latency_ms END),0) AS latency FROM proxies`, [settings.minChecks, settings.minSuccessRate]);
    const bySource = Object.fromEntries(this.queryAll('SELECT source, COUNT(*) AS count FROM proxies GROUP BY source').map((item) => [item.source, item.count]));
    return { total: row.total, healthy: row.stable, stable: row.stable, alive_latest: row.alive, average_latency_ms: Math.round(row.latency * 100) / 100, by_source: bySource };
  }

  protocolCounts() {
    return Object.fromEntries(this.queryAll(`SELECT UPPER(protocol) AS protocol, COUNT(*) AS count
      FROM proxies WHERE alive=1 AND check_count>=? AND success_rate>=? GROUP BY protocol`, [settings.minChecks, settings.minSuccessRate])
      .map((item) => [item.protocol, item.count]));
  }

  prune() {
    const result = this.db.run(`DELETE FROM proxies WHERE (last_checked IS NOT NULL AND last_success IS NULL)
      OR (failures >= 5 AND success_rate < ? )`, [settings.minSuccessRate]);
    if (result.changes) this.save();
    return result.changes;
  }

  close() {
    this.save();
    this.db.close();
  }
}
