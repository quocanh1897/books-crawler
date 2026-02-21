"""HTTP client for tangthuvien with throttling and retries."""
from __future__ import annotations

import time

import httpx

from config import BASE_URL, HEADERS, MAX_RETRIES, REQUEST_DELAY


class FetchError(Exception):
    pass


class NotFound(FetchError):
    pass


class RateLimited(FetchError):
    pass


class TangThuVienClient:
    """Synchronous HTTP client with rate limiting and retries."""

    def __init__(self, delay: float = REQUEST_DELAY, max_retries: int = MAX_RETRIES):
        self.delay = delay
        self.max_retries = max_retries
        self._client = httpx.Client(
            headers=HEADERS,
            timeout=30,
            follow_redirects=True,
        )
        self._last_request = 0.0

    def close(self):
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _throttle(self):
        elapsed = time.time() - self._last_request
        if elapsed < self.delay:
            time.sleep(self.delay - elapsed)
        self._last_request = time.time()

    def get(self, url: str, params: dict | None = None) -> httpx.Response:
        """Fetch a URL with throttling and retries. Returns the response object."""
        if not url.startswith("http"):
            url = f"{BASE_URL}{url}"

        for attempt in range(self.max_retries):
            self._throttle()
            try:
                r = self._client.get(url, params=params)
            except httpx.TransportError as e:
                if attempt < self.max_retries - 1:
                    time.sleep(2 ** (attempt + 1))
                    continue
                raise FetchError(f"Transport error after {self.max_retries} retries: {e}")

            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 2 ** (attempt + 2)))
                if attempt < self.max_retries - 1:
                    time.sleep(wait)
                    continue
                raise RateLimited(f"Rate limited, retry after {wait}s")

            if r.status_code == 404:
                raise NotFound(f"Not found: {url}")

            if r.status_code != 200:
                if attempt < self.max_retries - 1:
                    time.sleep(2 ** (attempt + 1))
                    continue
                raise FetchError(f"HTTP {r.status_code}: {url}")

            return r

        raise FetchError(f"Failed after {self.max_retries} retries: {url}")

    def get_html(self, url: str, params: dict | None = None) -> str:
        """Fetch a URL and return the response text."""
        return self.get(url, params=params).text

    def get_bytes(self, url: str) -> bytes:
        """Fetch a URL and return raw bytes (for images)."""
        return self.get(url).content


class AsyncTangThuVienClient:
    """Async HTTP client for parallel batch downloads.

    Uses a global semaphore to cap concurrent in-flight requests regardless
    of how many workers are running.  This lets you safely use 50+ workers
    (for book-level parallelism) without flooding the server.
    """

    def __init__(
        self,
        delay: float = REQUEST_DELAY,
        max_retries: int = MAX_RETRIES,
        max_concurrent: int = 20,
    ):
        import asyncio

        self.delay = delay
        self.max_retries = max_retries
        self._sem = asyncio.Semaphore(max_concurrent)
        self._client = httpx.AsyncClient(
            headers=HEADERS,
            timeout=httpx.Timeout(connect=10, read=20, write=10, pool=30),
            follow_redirects=True,
            limits=httpx.Limits(
                max_connections=max_concurrent + 10,
                max_keepalive_connections=max_concurrent,
            ),
        )

    async def close(self):
        await self._client.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.close()

    async def get(self, url: str, params: dict | None = None) -> httpx.Response:
        import asyncio

        if not url.startswith("http"):
            url = f"{BASE_URL}{url}"

        async with self._sem:
            for attempt in range(self.max_retries):
                await asyncio.sleep(self.delay)
                try:
                    r = await self._client.get(url, params=params)
                except httpx.TransportError as e:
                    if attempt < self.max_retries - 1:
                        await asyncio.sleep(2 ** (attempt + 1))
                        continue
                    raise FetchError(f"Transport error after {self.max_retries} retries: {e}")

                if r.status_code == 429:
                    wait = int(r.headers.get("Retry-After", 2 ** (attempt + 2)))
                    if attempt < self.max_retries - 1:
                        await asyncio.sleep(wait)
                        continue
                    raise RateLimited(f"Rate limited, retry after {wait}s")

                if r.status_code == 404:
                    raise NotFound(f"Not found: {url}")

                if r.status_code != 200:
                    if attempt < self.max_retries - 1:
                        await asyncio.sleep(2 ** (attempt + 1))
                        continue
                    raise FetchError(f"HTTP {r.status_code}: {url}")

                return r

        raise FetchError(f"Failed after {self.max_retries} retries: {url}")

    async def get_html(self, url: str, params: dict | None = None) -> str:
        return (await self.get(url, params=params)).text

    async def get_bytes(self, url: str) -> bytes:
        return (await self.get(url)).content
