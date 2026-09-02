import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.checker import check_all
from app.db import Database
from app.sources import SOURCES, fetch_source


async def main():
    db = Database(os.getenv("DATABASE_PATH", "./data/actions.db"))
    results = await asyncio.gather(*(fetch_source(source) for source in SOURCES), return_exceptions=True)
    for source, result in zip(SOURCES, results):
        if isinstance(result, set):
            await db.add_many(result, source.name)
    # Actions runners are ephemeral, so complete the minimum stability sample
    # in this run instead of waiting for a later runner.
    await check_all(db)
    await asyncio.sleep(2)
    await check_all(db)
    proxies = await db.healthy(500)
    os.makedirs("data", exist_ok=True)
    with open("data/proxies.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(proxies) + ("\n" if proxies else ""))
    with open("data/proxies.json", "w", encoding="utf-8") as f:
        json.dump({"count": len(proxies), "proxies": proxies}, f, indent=2)
    print(f"Exported {len(proxies)} healthy proxies")


if __name__ == "__main__":
    asyncio.run(main())
