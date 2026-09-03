import argparse
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.checker import check_all
from app.config import settings
from app.db import Database
from app.sources import SOURCES, fetch_source


if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


async def run(limit: int):
    with tempfile.TemporaryDirectory() as temp_dir:
        db = Database(os.path.join(temp_dir, "smoke.db"))
        results = await asyncio.gather(*(fetch_source(source) for source in SOURCES), return_exceptions=True)
        fetched = 0
        failed_sources = []
        for source, result in zip(SOURCES, results):
            if isinstance(result, set):
                fetched += len(result)
                await db.add_many(result, source.name)
            else:
                failed_sources.append(source.name)

        candidates = await db.candidates()
        original_limit = settings.max_candidates_per_cycle
        settings.max_candidates_per_cycle = limit
        try:
            first = await check_all(db)
            second = await check_all(db, alive_only=True)
        finally:
            settings.max_candidates_per_cycle = original_limit

        stable = await db.healthy(limit)
        protocols = await db.protocol_counts()
        print(f"sources={len(SOURCES)} source_failures={len(failed_sources)} fetched={fetched} unique={len(candidates)}")
        print(f"checks={first['tested'] + second['tested']} first_pass={first['tested']} second_pass={second['tested']} stable={len(stable)}")
        print("protocols=" + ",".join(f"{name}:{protocols.get(name, 0)}" for name in ("HTTP", "HTTPS", "SOCKS4", "SOCKS5")))
        if failed_sources:
            print("failed_sources=" + ",".join(failed_sources))


def main():
    parser = argparse.ArgumentParser(description="Run an isolated live proxy smoke test")
    parser.add_argument("--limit", type=int, default=100, help="Maximum candidates to test")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be at least 1")
    asyncio.run(run(args.limit))


if __name__ == "__main__":
    main()
