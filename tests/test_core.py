import asyncio
import tempfile
import unittest
from pathlib import Path

from app.checker import check_all, check_one
from app.db import Database


class ProxyPoolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db = Database(str(Path(self.temp_dir.name) / "actions.db"))

    async def asyncTearDown(self):
        self.temp_dir.cleanup()

    async def test_broken_proxies_do_not_stop_batch(self):
        proxies = {"socks5://127.0.0.1:1", "socks4://127.0.0.1:1"}
        await self.db.add_many(proxies, "test")
        result = await check_all(self.db)
        self.assertEqual(result["tested"], 2)
        self.assertEqual(result["unexpected"], 0)
        self.assertEqual(await self.db.healthy(50), [])

    async def test_proxy_needs_two_successes(self):
        proxy = "http://127.0.0.1:8080"
        await self.db.add_many({proxy}, "test")
        await self.db.update_check(proxy, True, 10)
        self.assertEqual(await self.db.healthy(50), [])
        await self.db.update_check(proxy, True, 10)
        self.assertEqual(await self.db.healthy(50), [proxy])

    async def test_cancellation_is_not_swallowed(self):
        proxy = "socks5://127.0.0.1:1"
        await self.db.add_many({proxy}, "test")
        task = asyncio.create_task(check_one(proxy, self.db, asyncio.Semaphore(1)))
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
