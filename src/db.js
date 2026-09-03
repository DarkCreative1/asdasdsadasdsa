import fs from 'node:fs';
import path from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { settings } from './config.js';

const updateSql = `UPDATE proxies SET alive=?, latency_ms=?, last_checked=?, check_count=check_count+1,
  successes=successes+?, failures=failures+?, success_rate=CAST(successes+? AS REAL)/(check_count+1),
  last_success=CASE WHEN ? THEN ? ELSE last_success END WHERE proxy=?`;

export class Database {
  constructor(databasePath = settings.databasePath) {
    fs.mkdirSync(path.dirname(databasePath) || '.', { recursive: true });
    this.path = databasePath;
    this.db = new SqliteDatabase(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 30000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS proxies (
      proxy TEXT PRIMARY KEY, protocol TEXT NOT NULL, alive INTEGER DEFAULT 0,
      latency_ms REAL, successes INTEGER DEFAULT 0, failures INTEGER DEFAULT 0,
      last_checked TEXT, last_success TEXT, source TEXT, created_at TEXT NOT NULL,
      check_count INTEGER DEFAULT 0, success_rate REAL DEFAULT 0
    )`);
  }

  addMany(proxies, source) {
    const insert = this.db.prepare(`INSERT INTO proxies(proxy, protocol, source, created_at)
      VALUES(?,?,?,?) ON CONFLICT(proxy) DO UPDATE SET source=excluded.source`);
    const add = this.db.transaction((values) => {
      const createdAt = new Date().toISOString();
      for (const proxy of values) insert.run(proxy, proxy.split(':', 1)[0], source, createdAt);
    });
    add(proxies);
  }

  updateCheck(proxy, alive, latency) {
    this.updateChecks([[proxy, alive, latency]]);
  }

  updateChecks(checks) {
    if (!checks.length) return;
    const update = this.db.prepare(updateSql);
    const write = this.db.transaction((values) => {
      const checkedAt = new Date().toISOString();
      for (const [proxy, alive, latency] of values) {
        const flag = alive ? 1 : 0;
        update.run(flag, latency, checkedAt, flag, alive ? 0 : 1, flag, flag, checkedAt, proxy);
      }
    });
    write(checks);
  }

  candidates({ aliveOnly = false, staleOnly = false } = {}) {
    const conditions = [];
    const params = {};
    if (aliveOnly) conditions.push('alive=1');
    if (staleOnly) {
      const cutoff = new Date(Date.now() - settings.staleAfterSeconds * 1000).toISOString();
      conditions.push('(last_checked IS NULL OR last_checked <= @cutoff)');
      params.cutoff = cutoff;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db.prepare(`SELECT proxy FROM proxies ${where}
      ORDER BY alive DESC, success_rate DESC,
        CASE WHEN source LIKE 'monosans-%' THEN 0
             WHEN source LIKE 'proxifly-%' THEN 1
             WHEN source LIKE 'iplocate-%' THEN 2 ELSE 3 END,
        latency_ms ASC NULLS LAST`).all(params).map((row) => row.proxy);
  }

  healthy(limit = 500) {
    return this.db.prepare(`SELECT proxy FROM proxies WHERE alive=1 AND check_count>=?
      AND success_rate>=? ORDER BY latency_ms ASC LIMIT ?`)
      .all(settings.minChecks, settings.minSuccessRate, limit).map((row) => row.proxy);
  }

  healthyProtocol(protocol, limit = 500) {
    return this.db.prepare(`SELECT proxy FROM proxies WHERE protocol=? AND alive=1
      AND check_count>=? AND success_rate>=? ORDER BY latency_ms ASC LIMIT ?`)
      .all(protocol, settings.minChecks, settings.minSuccessRate, limit).map((row) => row.proxy);
  }

  stats() {
    const row = this.db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(alive),0) AS alive,
      COALESCE(SUM(CASE WHEN alive=1 AND check_count>=? AND success_rate>=? THEN 1 ELSE 0 END),0) AS stable,
      COALESCE(AVG(CASE WHEN alive=1 THEN latency_ms END),0) AS latency FROM proxies`)
      .get(settings.minChecks, settings.minSuccessRate);
    const bySource = Object.fromEntries(this.db.prepare('SELECT source, COUNT(*) AS count FROM proxies GROUP BY source').all().map((item) => [item.source, item.count]));
    return { total: row.total, healthy: row.stable, stable: row.stable, alive_latest: row.alive, average_latency_ms: Math.round(row.latency * 100) / 100, by_source: bySource };
  }

  protocolCounts() {
    return Object.fromEntries(this.db.prepare(`SELECT UPPER(protocol) AS protocol, COUNT(*) AS count
      FROM proxies WHERE alive=1 AND check_count>=? AND success_rate>=? GROUP BY protocol`)
      .all(settings.minChecks, settings.minSuccessRate).map((item) => [item.protocol, item.count]));
  }

  prune() {
    return this.db.prepare(`DELETE FROM proxies WHERE (last_checked IS NOT NULL AND last_success IS NULL)
      OR (failures >= 5 AND success_rate < ? )`).run(settings.minSuccessRate).changes;
  }

  close() {
    this.db.close();
  }
}
