import asyncio
import time
import aiohttp
from aiohttp_socks import ProxyConnector
from .config import settings
from .db import Database

CHECK_URLS = tuple(x.strip() for x in settings.check_targets.split(",") if x.strip())


async def _probe(proxy: str, http_session: aiohttp.ClientSession | None):
    timeout = aiohttp.ClientTimeout(total=settings.check_timeout_seconds)
    if proxy.startswith(("socks4://", "socks5://")):
        connector = ProxyConnector.from_url(proxy)
        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as client:
            for target in CHECK_URLS:
                async with client.get(target, allow_redirects=False) as response:
                    if response.status != 204:
                        return False
        return True

    transport_proxy = "http://" + proxy.removeprefix("https://") if proxy.startswith("https://") else proxy
    owns_session = http_session is None
    client = http_session or aiohttp.ClientSession(timeout=timeout)
    try:
        for target in CHECK_URLS:
            async with client.get(
                target,
                proxy=transport_proxy,
                allow_redirects=False,
                headers={"User-Agent": "proxy-pool-health-check/2.0"},
            ) as response:
                if response.status != 204:
                    return False
        return True
    finally:
        if owns_session:
            await client.close()


async def check_one(
    proxy: str,
    db: Database,
    semaphore: asyncio.Semaphore,
    persist: bool = True,
    http_session: aiohttp.ClientSession | None = None,
):
    async with semaphore:
        started = time.perf_counter()
        try:
            async with asyncio.timeout(settings.check_timeout_seconds + 0.25):
                passed = await _probe(proxy, http_session)
            latency = round((time.perf_counter() - started) * 1000, 2)
            # A proxy is accepted only if it responds within the configured SLA.
            alive = passed and latency <= settings.check_timeout_seconds * 1000
            stored_latency = latency if alive else None
            if persist:
                await db.update_check(proxy, alive, stored_latency)
            return {"proxy": proxy, "alive": alive, "latency": stored_latency, "error": None}
        except asyncio.CancelledError:
            # Cancellation belongs to the caller (and must never be swallowed).
            raise
        except Exception as exc:
            # Public proxies frequently close a SOCKS handshake midway through
            # an asyncio read.  aiohttp-socks can surface that as
            # IncompleteReadError, TimeoutError, OSError, or a connector-specific
            # exception, so keep this boundary deliberately broad.  A bad proxy
            # is a normal result of a health check, not a batch failure.
            if persist:
                try:
                    await db.update_check(proxy, False, None)
                except asyncio.CancelledError:
                    raise
                except Exception as db_exc:
                    return {"proxy": proxy, "alive": False, "latency": None, "error": f"database:{type(db_exc).__name__}"}
            return {"proxy": proxy, "alive": False, "latency": None, "error": type(exc).__name__}


async def check_all(db: Database, alive_only: bool = False, stale_only: bool = False):
    # Checking in bounded batches prevents thousands of public entries from
    # creating an unbounded number of tasks and file descriptors.
    proxies = await db.candidates(alive_only=alive_only, stale_only=stale_only)
    if settings.max_candidates_per_cycle > 0:
        proxies = proxies[: settings.max_candidates_per_cycle]
    semaphore = asyncio.Semaphore(settings.check_concurrency)
    timeout = aiohttp.ClientTimeout(total=settings.check_timeout_seconds)
    connector = aiohttp.TCPConnector(limit=settings.check_concurrency)
    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as http_session:
        results = await asyncio.gather(
            *(check_one(p, db, semaphore, persist=False, http_session=http_session) for p in proxies),
            return_exceptions=True,
        )
    unexpected = 0
    failed = 0
    error_types = {}
    checks = []
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
            checks.append((result["proxy"], False, None))
        else:
            checks.append((result["proxy"], True, result["latency"]))
    try:
        await db.update_checks(checks)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        unexpected += len(checks)
        error_name = f"database:{type(exc).__name__}"
        error_types[error_name] = error_types.get(error_name, 0) + len(checks)
    return {"tested": len(proxies), "failed": failed, "unexpected": unexpected, "error_types": error_types}
