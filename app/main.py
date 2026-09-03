import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, Header, HTTPException, Query
from .config import settings
from .db import Database
from .sources import SOURCES, fetch_source
from .checker import check_all

db = Database(settings.database_path)


async def fetch_all():
    results = await asyncio.gather(*(fetch_source(s) for s in SOURCES), return_exceptions=True)
    summary = {}
    for source, result in zip(SOURCES, results):
        if isinstance(result, set):
            await db.add_many(result, source.name)
            summary[source.name] = len(result)
        else:
            summary[source.name] = 0
    return summary


async def worker():
    last_fetch = 0.0
    while True:
        now = asyncio.get_running_loop().time()
        if now - last_fetch >= settings.fetch_interval_seconds:
            await fetch_all()
            last_fetch = now
        await check_all(db, stale_only=True)
        await db.prune()
        await asyncio.sleep(settings.check_interval_seconds)


@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(worker())
    yield
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


app = FastAPI(title="Proxy Pool API", version="0.1.0", lifespan=lifespan)


def auth(key: str | None):
    if settings.api_key and key != settings.api_key:
        raise HTTPException(401, "Invalid API key")


@app.get("/health")
async def health():
    stats = await db.stats()
    stable = len(await db.healthy(settings.target_pool_size))
    return {"ok": stable >= settings.target_pool_size, "stable": stable, **stats}


@app.get("/proxies")
async def proxies(limit: int = Query(50, ge=1, le=500), x_api_key: str | None = Header(None)):
    auth(x_api_key)
    values = await db.healthy(limit)
    if len(values) < settings.target_pool_size:
        raise HTTPException(503, f"Only {len(values)} healthy proxies available")
    return {"count": len(values), "proxies": values}


@app.get("/proxies/{protocol}")
async def proxies_by_protocol(protocol: str, limit: int = Query(50, ge=1, le=500), x_api_key: str | None = Header(None)):
    auth(x_api_key)
    if protocol not in {"http", "https", "socks4", "socks5"}:
        raise HTTPException(400, "Protocol must be http, https, socks4 or socks5")
    values = await db.healthy_protocol(protocol, limit)
    return {"protocol": protocol, "count": len(values), "proxies": values}


@app.post("/refresh")
async def refresh(x_api_key: str | None = Header(None)):
    auth(x_api_key)
    return {"sources": await fetch_all()}


@app.get("/metrics")
async def metrics(x_api_key: str | None = Header(None)):
    auth(x_api_key)
    return await db.stats()
