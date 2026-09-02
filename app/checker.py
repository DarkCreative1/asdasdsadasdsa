import asyncio
import random
import time
import httpx
import aiohttp
from aiohttp_socks import ProxyConnector
from .config import settings
from .db import Database

CHECK_URLS = tuple(x.strip() for x in settings.check_targets.split(",") if x.strip())


async def check_one(proxy: str, db: Database, semaphore: asyncio.Semaphore):
    async with semaphore:
        started = time.perf_counter()
        try:
            results = []
            if proxy.startswith(("socks4://", "socks5://")):
                connector = ProxyConnector.from_url(proxy)
                async with aiohttp.ClientSession(connector=connector) as client:
                    for target in random.sample(CHECK_URLS, k=len(CHECK_URLS)):
                        async with client.get(target, timeout=settings.check_timeout_seconds, allow_redirects=False) as response:
                            results.append(response.status in (200, 204, 301, 302))
            else:
                async with httpx.AsyncClient(proxy=proxy, timeout=settings.check_timeout_seconds, follow_redirects=False) as client:
                    for target in random.sample(CHECK_URLS, k=len(CHECK_URLS)):
                        response = await client.get(target, headers={"User-Agent": "proxy-pool-health-check/1.0"})
                        results.append(response.status_code in (200, 204, 301, 302))
            latency = round((time.perf_counter() - started) * 1000, 2)
            # A proxy is accepted only if it responds within the configured SLA.
            alive = all(results) and latency <= settings.check_timeout_seconds * 1000
            await db.update_check(proxy, alive, latency if alive else None)
        except (httpx.HTTPError, aiohttp.ClientError, OSError, ValueError):
            await db.update_check(proxy, False, None)


async def check_all(db: Database):
    # Checking in bounded batches prevents thousands of public entries from
    # creating an unbounded number of tasks and file descriptors.
    proxies = await db.candidates()
    if settings.max_candidates_per_cycle > 0:
        proxies = proxies[: settings.max_candidates_per_cycle]
    semaphore = asyncio.Semaphore(settings.check_concurrency)
    await asyncio.gather(*(check_one(p, db, semaphore) for p in proxies))
