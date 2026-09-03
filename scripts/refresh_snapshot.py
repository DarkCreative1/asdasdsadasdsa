import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.checker import check_all
from app.db import Database
from app.sources import SOURCES, fetch_source


if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


async def main():
    db = Database(os.getenv("DATABASE_PATH", "data/actions.db"))
    results = await asyncio.gather(*(fetch_source(source) for source in SOURCES), return_exceptions=True)
    fetched = 0
    for source, result in zip(SOURCES, results):
        if isinstance(result, set):
            fetched += len(result)
            await db.add_many(result, source.name)
        else:
            print(f"[source] {source.name}: failed ({type(result).__name__})")
    candidates = await db.candidates()
    print(f"Fetched {fetched} proxy entries; {len(candidates)} unique candidates in database")
    # Actions runners are ephemeral, so complete the minimum stability sample
    # in this run instead of waiting for a later runner.
    first = await check_all(db)
    # A second pass is only needed for proxies that passed the first one.
    # This preserves the two-success stability rule without retesting every
    # known-dead public endpoint.
    second = await check_all(db, alive_only=True)
    proxies = await db.healthy(500)
    os.makedirs("data", exist_ok=True)
    with open("data/proxies.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(proxies) + ("\n" if proxies else ""))
    with open("data/proxies.json", "w", encoding="utf-8") as f:
        json.dump({"count": len(proxies), "proxies": proxies}, f, indent=2)
    tested = first["tested"] + second["tested"]
    failed = first["failed"] + second["failed"]
    errors = {}
    for stats in (first, second):
        for error_type, count in stats["error_types"].items():
            errors[error_type] = errors.get(error_type, 0) + count
    error_summary = ", ".join(f"{name}={count}" for name, count in sorted(errors.items())) or "none"
    print(f"Tested {tested} proxy checks ({first['tested']} + {second['tested']}); failed checks: {failed}; stable proxies: {len(proxies)}")
    print(f"Check error summary: {error_summary}")
    counts = await db.protocol_counts()
    print("Stable by protocol: " + ", ".join(f"{protocol}={counts.get(protocol, 0)}" for protocol in ("HTTP", "HTTPS", "SOCKS4", "SOCKS5")))
    print(f"Exported {len(proxies)} healthy proxies")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        # Keep scheduled runs readable if an infrastructure error occurs.
        print(f"[snapshot] controlled failure: {type(exc).__name__}: {exc}")
