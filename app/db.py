import asyncio
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from .config import settings


def now():
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.path = path
        with self._connection() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA busy_timeout=30000")
            c.execute("""CREATE TABLE IF NOT EXISTS proxies (
                proxy TEXT PRIMARY KEY, protocol TEXT NOT NULL, alive INTEGER DEFAULT 0,
                latency_ms REAL, successes INTEGER DEFAULT 0, failures INTEGER DEFAULT 0,
                last_checked TEXT, last_success TEXT, source TEXT, created_at TEXT NOT NULL
            )""")
            for column, definition in (("check_count", "INTEGER DEFAULT 0"), ("success_rate", "REAL DEFAULT 0")):
                try:
                    c.execute(f"ALTER TABLE proxies ADD COLUMN {column} {definition}")
                except sqlite3.OperationalError:
                    pass

    @contextmanager
    def _connection(self):
        connection = sqlite3.connect(self.path, timeout=30)
        try:
            connection.execute("PRAGMA busy_timeout=30000")
            yield connection
        except BaseException:
            connection.rollback()
            raise
        else:
            connection.commit()
        finally:
            connection.close()

    async def add_many(self, proxies: set[str], source: str):
        def work():
            with self._connection() as c:
                for proxy in proxies:
                    protocol = proxy.split(":", 1)[0]
                    c.execute("""INSERT INTO proxies(proxy,protocol,source,created_at) VALUES(?,?,?,?)
                    ON CONFLICT(proxy) DO UPDATE SET source=excluded.source""", (proxy, protocol, source, now()))
        await asyncio.to_thread(work)

    async def update_check(self, proxy: str, alive: bool, latency: float | None):
        def work():
            with self._connection() as c:
                c.execute("""UPDATE proxies SET alive=?, latency_ms=?, last_checked=?, check_count=check_count+1,
                    successes=successes+?, failures=failures+?,
                    success_rate=CAST(successes+? AS REAL)/(successes+failures+1),
                    last_success=CASE WHEN ? THEN ? ELSE last_success END WHERE proxy=?""",
                    (int(alive), latency, now(), int(alive), int(not alive), int(alive), int(alive), now(), proxy))
        await asyncio.to_thread(work)

    async def candidates(self, alive_only: bool = False, stale_only: bool = False):
        def work():
            with self._connection() as c:
                conditions = []
                params = []
                if alive_only:
                    conditions.append("alive=1")
                if stale_only:
                    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=settings.stale_after_seconds)).isoformat()
                    conditions.append("(last_checked IS NULL OR last_checked <= ?)")
                    params.append(cutoff)
                where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
                query = f"SELECT proxy FROM proxies {where} ORDER BY alive DESC, success_rate DESC, latency_ms ASC NULLS LAST"
                return [r[0] for r in c.execute(query, params)]
        return await asyncio.to_thread(work)

    async def healthy(self, limit: int):
        def work():
            with self._connection() as c:
                return [r[0] for r in c.execute("""SELECT proxy FROM proxies
                    WHERE alive=1 AND check_count>=? AND success_rate>=?
                    ORDER BY latency_ms ASC LIMIT ?""", (settings.min_checks, settings.min_success_rate, limit))]
        return await asyncio.to_thread(work)

    async def healthy_protocol(self, protocol: str, limit: int):
        def work():
            with self._connection() as c:
                return [r[0] for r in c.execute("""SELECT proxy FROM proxies
                    WHERE protocol=? AND alive=1 AND check_count>=? AND success_rate>=?
                    ORDER BY latency_ms ASC LIMIT ?""", (protocol, settings.min_checks, settings.min_success_rate, limit))]
        return await asyncio.to_thread(work)

    async def stats(self):
        def work():
            with self._connection() as c:
                total, alive, latency = c.execute("SELECT COUNT(*), COALESCE(SUM(alive),0), COALESCE(AVG(latency_ms),0) FROM proxies").fetchone()
                by_source = dict(c.execute("SELECT source, COUNT(*) FROM proxies GROUP BY source").fetchall())
                return total, alive, latency, by_source
        total, alive, latency, by_source = await asyncio.to_thread(work)
        return {"total": total, "healthy": alive, "average_latency_ms": round(latency, 2), "by_source": by_source}

    async def protocol_counts(self):
        def work():
            with self._connection() as c:
                rows = c.execute("""SELECT protocol, COUNT(*) FROM proxies
                    WHERE alive=1 AND check_count>=? AND success_rate>=?
                    GROUP BY protocol ORDER BY protocol""", (settings.min_checks, settings.min_success_rate)).fetchall()
                return {protocol.upper(): count for protocol, count in rows}
        return await asyncio.to_thread(work)

    async def prune(self):
        """Remove proxies that have not succeeded recently or have repeatedly failed."""
        def work():
            with self._connection() as c:
                return c.execute("""DELETE FROM proxies WHERE
                    (last_checked IS NOT NULL AND last_success IS NULL) OR
                    (failures >= 5 AND success_rate < ?)""", (settings.min_success_rate,)).rowcount
        return await asyncio.to_thread(work)
