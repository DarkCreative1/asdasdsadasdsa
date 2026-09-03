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
            return {"alive": alive, "error": None}
        except asyncio.CancelledError:
            # Cancellation belongs to the caller (and must never be swallowed).
            raise
        except Exception as exc:
            # Public proxies frequently close a SOCKS handshake midway through
            # an asyncio read.  aiohttp-socks can surface that as
            # IncompleteReadError, TimeoutError, OSError, or a connector-specific
            # exception, so keep this boundary deliberately broad.  A bad proxy
            # is a normal result of a health check, not a batch failure.
            try:
                await db.update_check(proxy, False, None)
            except asyncio.CancelledError:
                raise
            except Exception as db_exc:
                return {"alive": False, "error": f"database:{type(db_exc).__name__}"}
            return {"alive": False, "error": type(exc).__name__}


async def check_all(db: Database, alive_only: bool = False):
    # Checking in bounded batches prevents thousands of public entries from
    # creating an unbounded number of tasks and file descriptors.
    proxies = await db.candidates(alive_only=alive_only)
    if settings.max_candidates_per_cycle > 0:
        proxies = proxies[: settings.max_candidates_per_cycle]
    semaphore = asyncio.Semaphore(settings.check_concurrency)
    results = await asyncio.gather(
        *(check_one(p, db, semaphore) for p in proxies),
        return_exceptions=True,
    )
    unexpected = 0
    failed = 0
    error_types = {}
    for result in results:
        if isinstance(result, asyncio.CancelledError):
            raise result
        if isinstance(result, Exception):
            # Defensive guard for future changes to check_one.  It keeps one
            # proxy task from cancelling the complete scan.
            unexpected += 1
            print(f"[check] unexpected task failure: {type(result).__name__}")
        elif not result["alive"]:
            failed += 1
            if result["error"]:
                error_types[result["error"]] = error_types.get(result["error"], 0) + 1
    return {"tested": len(proxies), "failed": failed, "unexpected": unexpected, "error_types": error_types}
