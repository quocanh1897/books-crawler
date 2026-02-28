"""TF source — truyenfull.vision HTML scraper.

Fetches book metadata and chapter content from the public TruyenFull website
by parsing server-rendered HTML.  No authentication required.

The module is self-contained: it includes an async HTTP client with
throttling, HTML parsers for every page type, and a book-ID registry that
assigns 30 000 000+ numeric IDs to TF slugs (avoiding collisions with MTC
IDs < 1M and TTV IDs at 10M+).

Only completed ("Full") hot books are discovered via the listing at
``/danh-sach/truyen-hot/trang-{N}/``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
from collections.abc import AsyncIterator
from html import unescape
from pathlib import Path

import httpx
from bs4 import BeautifulSoup, Tag

from ..db import slugify as _slugify
from .base import BookSource, ChapterData

log = logging.getLogger("book-ingest.tf")

# ═══════════════════════════════════════════════════════════════════════════
# Config
# ═══════════════════════════════════════════════════════════════════════════

TF_BASE_URL = "https://truyenfull.vision"

TF_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
}

TF_DEFAULT_DELAY = 0.15  # seconds between requests
TF_DEFAULT_MAX_CONCURRENT = 20

# TF book IDs start at 30M to avoid collision with MTC (< 1M) and TTV (10M+).
ID_OFFSET = 30_000_000

# TF author IDs start at 40M to avoid collision with MTC, TTV (20M+), and
# synthetic 999xxx authors.
AUTHOR_ID_OFFSET = 40_000_000

# ── Paths ───────────────────────────────────────────────────────────────────

_INGEST_DIR = Path(__file__).resolve().parent.parent.parent  # book-ingest/
DATA_DIR = _INGEST_DIR / "data"
REGISTRY_PATH = DATA_DIR / "book_registry_tf.json"
TF_PLAN_FILE = DATA_DIR / "books_plan_tf.json"
BINSLIB_DB_PATH = _INGEST_DIR.parent / "binslib" / "data" / "binslib.db"


# ═══════════════════════════════════════════════════════════════════════════
# Async HTTP client
# ═══════════════════════════════════════════════════════════════════════════


class TFFetchError(Exception):
    """Any non-recoverable HTTP error from TF."""


class TFNotFound(TFFetchError):
    """HTTP 404 from TF."""


class _AsyncTFClient:
    """Async HTTP client with semaphore-based throttling and retries."""

    def __init__(
        self,
        delay: float = TF_DEFAULT_DELAY,
        max_concurrent: int = TF_DEFAULT_MAX_CONCURRENT,
        timeout: float = 30,
        max_retries: int = 3,
    ):
        self._sem = asyncio.Semaphore(max_concurrent)
        self._delay = delay
        self._max_retries = max_retries
        self._client = httpx.AsyncClient(
            headers=TF_HEADERS,
            timeout=httpx.Timeout(connect=10, read=timeout, write=10, pool=30),
            follow_redirects=True,
            limits=httpx.Limits(
                max_connections=max_concurrent + 10,
                max_keepalive_connections=max_concurrent,
            ),
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def get(
        self, url: str, params: dict | None = None, retries: int | None = None
    ) -> httpx.Response:
        if not url.startswith("http"):
            url = f"{TF_BASE_URL}{url}"

        retries = retries if retries is not None else self._max_retries

        for attempt in range(retries):
            # Sleep OUTSIDE the semaphore to avoid holding a slot idle.
            # Jitter the base delay (50%–150%) so concurrent requests don't
            # all hit the server at the same instant (thundering herd).
            # On retries, add extra delay so repeated failures back off.
            jittered_delay = self._delay * (0.5 + random.random())
            if attempt > 0:
                jittered_delay += random.uniform(2, 8)
            await asyncio.sleep(jittered_delay)
            async with self._sem:
                try:
                    r = await self._client.get(url, params=params)
                except httpx.TransportError as exc:
                    if attempt < retries - 1:
                        await asyncio.sleep(random.uniform(3, 10))
                        continue
                    raise TFFetchError(
                        f"Transport error after {retries} retries: {exc}"
                    ) from exc

            if r.status_code == 429:
                server_wait = int(r.headers.get("Retry-After", 5))
                wait = server_wait + random.uniform(1, 5)
                if attempt < retries - 1:
                    log.debug(
                        "429 rate-limited %s, retry %d/%d in %.1fs",
                        url,
                        attempt + 1,
                        retries,
                        wait,
                    )
                    await asyncio.sleep(wait)
                    continue
                raise TFFetchError(f"Rate limited after {retries} retries")

            if r.status_code == 404:
                raise TFNotFound(f"Not found: {url}")

            if r.status_code == 503:
                # Server overloaded — random jitter backoff to prevent
                # thundering herd.  Use 3-10s range (not 1-10) so the
                # server has real breathing room before the next attempt.
                wait = random.uniform(3, 10)
                if attempt < retries - 1:
                    log.debug(
                        "503 server busy %s, retry %d/%d in %.1fs",
                        url,
                        attempt + 1,
                        retries,
                        wait,
                    )
                    await asyncio.sleep(wait)
                    continue
                raise TFFetchError(f"HTTP 503 after {retries} retries: {url}")

            if r.status_code != 200:
                wait = random.uniform(3, 10)
                if attempt < retries - 1:
                    log.debug(
                        "HTTP %d %s, retry %d/%d in %.1fs",
                        r.status_code,
                        url,
                        attempt + 1,
                        retries,
                        wait,
                    )
                    await asyncio.sleep(wait)
                    continue
                raise TFFetchError(f"HTTP {r.status_code}: {url}")

            return r

        raise TFFetchError(f"Failed after {retries} retries: {url}")

    async def get_html(self, url: str, params: dict | None = None) -> str:
        return (await self.get(url, params=params)).text

    async def get_bytes(self, url: str) -> bytes:
        return (await self.get(url)).content


# ═══════════════════════════════════════════════════════════════════════════
# HTML parsers
# ═══════════════════════════════════════════════════════════════════════════

# ---------------------------------------------------------------------------
# Listing page  (/danh-sach/truyen-hot/trang-{N}/)
# ---------------------------------------------------------------------------


def parse_listing_page(html: str) -> list[dict]:
    """Parse a hot-books listing page and return book entries.

    Each entry has keys: ``name``, ``slug``, ``tf_slug``, ``author_name``,
    ``chapter_count``, ``cover_url``, ``hot_rank`` (position on listing).
    """
    soup = BeautifulSoup(html, "lxml")
    books: list[dict] = []

    for row in soup.select("div.list-truyen .row[itemscope]"):
        try:
            book = _parse_listing_item(row)
            if book:
                books.append(book)
        except Exception:
            continue
    # Assign hot_rank based on position (caller adds page offset)
    for i, book in enumerate(books):
        book["hot_rank"] = i + 1
    return books


def parse_listing_last_page(html: str) -> int:
    """Extract the last page number from pagination links."""
    soup = BeautifulSoup(html, "lxml")
    max_page = 1
    for a in soup.select("ul.pagination li a"):
        href = a.get("href", "")
        m = re.search(r"trang-(\d+)", str(href))
        if m:
            max_page = max(max_page, int(m.group(1)))
    return max_page


def _parse_listing_item(row: Tag) -> dict | None:
    """Parse a single book row from the listing page."""
    title_a = row.select_one("h3.truyen-title a")
    if not title_a:
        return None

    name = title_a.get_text(strip=True)
    href = title_a.get("href", "")

    # Extract tf_slug from URL: https://truyenfull.vision/than-dao-dan-ton-6060282/
    tf_slug = href.rstrip("/").split("/")[-1] if href else ""
    if not tf_slug:
        return None

    # ASCII-clean slug for DB
    slug = _slugify(unescape(name)) or tf_slug

    # Author
    author_span = row.select_one("span.author")
    author_name = author_span.get_text(strip=True) if author_span else ""

    # Chapter count — from ".col-xs-2.text-info" containing "Chương5357"
    ch_el = row.select_one(".col-xs-2.text-info")
    chapter_count = 0
    if ch_el:
        ch_text = ch_el.get_text(strip=True)
        m = re.search(r"(\d+)", ch_text)
        if m:
            chapter_count = int(m.group(1))

    # Cover image (lazy-loaded)
    cover_div = row.select_one(".lazyimg")
    cover_url = ""
    if cover_div:
        cover_url = cover_div.get("data-image", "") or cover_div.get(
            "data-desk-image", ""
        )

    return {
        "name": unescape(name),
        "slug": slug,
        "tf_slug": tf_slug,
        "author_name": unescape(author_name),
        "chapter_count": chapter_count,
        "cover_url": cover_url,
        "hot_rank": 0,  # Set by caller based on page position
    }


# ---------------------------------------------------------------------------
# Book detail page  (/{tf_slug}/)
# ---------------------------------------------------------------------------


def parse_book_detail(html: str, tf_slug: str) -> dict:
    """Parse a book detail page and return metadata.

    The returned dict is shaped for :func:`src.db.upsert_book_metadata`
    (minus ``id`` which the caller must set).
    """
    soup = BeautifulSoup(html, "lxml")

    # Title
    h1 = soup.select_one("h1")
    name = h1.get_text(strip=True) if h1 else tf_slug

    # Author — from the info section only
    author_el = soup.select_one(".info span[itemprop='author']")
    if not author_el:
        author_el = soup.select_one("span[itemprop='author']")
    author_name = author_el.get_text(strip=True) if author_el else ""

    # Genres — from the info section to avoid sidebar duplicates
    info_section = soup.select_one(".info") or soup.select_one(".col-info-desc")
    genres: list[dict] = []
    if info_section:
        seen_genres: set[str] = set()
        for a in info_section.select('a[itemprop="genre"]'):
            gname = a.get_text(strip=True)
            if gname and gname not in seen_genres:
                seen_genres.add(gname)
                genres.append({"name": gname, "slug": _slugify(gname)})

    # Status
    status = 2  # Default to completed since we only scrape "full" listing
    status_text = "Full"
    for div in soup.select(".info div"):
        text = div.get_text(strip=True)
        if "Trạng thái" in text:
            if "Full" in text or "Hoàn Thành" in text:
                status = 2
                status_text = "Full"
            elif "Đang ra" in text:
                status = 1
                status_text = "Đang ra"
            break

    # Synopsis
    desc_el = soup.select_one("div.desc-text")
    synopsis = ""
    if desc_el:
        # Get text, preserving line breaks
        synopsis_html = (
            desc_el.decode_contents().replace("<br/>", "\n").replace("<br>", "\n")
        )
        synopsis = BeautifulSoup(synopsis_html, "lxml").get_text(strip=True)

    # Cover image
    cover_el = soup.select_one(".book img, .books img, img[itemprop='image']")
    cover_url = cover_el.get("src", "") if cover_el else ""

    # Rating
    rating_val_el = soup.select_one("span[itemprop='ratingValue']")
    rating_count_el = soup.select_one("span[itemprop='ratingCount']")
    review_score = 0.0
    review_count = 0
    if rating_val_el:
        try:
            review_score = float(rating_val_el.get_text(strip=True))
        except ValueError:
            pass
    if rating_count_el:
        try:
            review_count = int(
                re.sub(r"[^\d]", "", rating_count_el.get_text(strip=True))
            )
        except ValueError:
            pass

    # Chapter count from the chapter list.
    # The first page shows up to 50 chapters; if paginated, we estimate
    # from (last_page - 1) * 50 + chapters_on_first_page.  This is still
    # an estimate — the listing page's "Chương N" is authoritative and
    # is preferred in fetch_book_metadata() when available.
    ch_links = soup.select("ul.list-chapter li a")
    chapter_count = len(ch_links)
    ch_pag_links = soup.select("#list-chapter ul.pagination li a")
    if ch_pag_links:
        last_ch_page = 1
        for a in ch_pag_links:
            href = a.get("href", "")
            m = re.search(r"trang-(\d+)", str(href))
            if m:
                last_ch_page = max(last_ch_page, int(m.group(1)))
        if last_ch_page > 1:
            # Estimate: (N-1) full pages + first page count (less aggressive
            # than the old last_page * 50 which always over-counted).
            chapter_count = (last_ch_page - 1) * 50 + len(ch_links)

    # Author ID — use a hash-based offset to avoid needing a separate registry
    author_id: int | None = None
    if author_name:
        # Simple deterministic ID from author name
        author_id = AUTHOR_ID_OFFSET + (hash(author_name) % 10_000_000)
        # Ensure positive
        if author_id < AUTHOR_ID_OFFSET:
            author_id += 10_000_000

    return {
        "name": unescape(name),
        "slug": _slugify(unescape(name)) or tf_slug,
        "tf_slug": tf_slug,
        "synopsis": unescape(synopsis),
        "status": status,
        "status_name": status_text,
        "view_count": 0,
        "comment_count": 0,
        "bookmark_count": 0,
        "vote_count": 0,
        "follow_count": 0,
        "review_score": review_score,
        "review_count": review_count,
        "chapter_count": chapter_count,
        "word_count": 0,
        "cover_url": cover_url,
        "author": {"id": author_id, "name": unescape(author_name)},
        "genres": genres,
        "tags": [],
        "created_at": None,
        "updated_at": None,
        "published_at": None,
        "new_chap_at": None,
        "source": "tf",
    }


# ---------------------------------------------------------------------------
# Chapter page  (/{tf_slug}/chuong-{N}/)
# ---------------------------------------------------------------------------


def parse_chapter(html: str) -> dict | None:
    """Parse a chapter page.

    Returns ``{"title": str, "body": str}`` or ``None`` if the page
    does not contain chapter content.

    TF chapter pages have a clean structure:
    - ``<h2>`` = chapter title (e.g. "Chương 1: Sống lại")
    - ``#chapter-c`` = body text (no title duplication, no ``<h5>`` issues)
    """
    soup = BeautifulSoup(html, "lxml")

    # Chapter title from <h2>
    h2 = soup.select_one("h2")
    if not h2:
        return None
    title = h2.get_text(strip=True).replace("\xa0", " ")

    # Body text from #chapter-c
    chapter_c = soup.select_one("#chapter-c")
    if not chapter_c:
        chapter_c = soup.select_one(".chapter-c")
    if not chapter_c:
        return None

    # Remove ad divs inside chapter content
    for ad in chapter_c.select(".ads-holder, .ads-responsive, script, ins"):
        ad.decompose()

    body = chapter_c.get_text(separator="\n").strip()
    if not body:
        return None

    return {"title": unescape(title), "body": body}


# ---------------------------------------------------------------------------
# Parser helpers
# ---------------------------------------------------------------------------


def _extract_tf_slug(url: str) -> str:
    """Extract the TF slug from a full URL.

    ``https://truyenfull.vision/than-dao-dan-ton-6060282/`` → ``than-dao-dan-ton-6060282``
    """
    return url.rstrip("/").split("/")[-1] if url else ""


def _extract_chapter_index(url: str) -> int:
    """Extract chapter index from a chapter URL.

    ``/than-dao-dan-ton-6060282/chuong-5/`` → ``5``
    """
    m = re.search(r"chuong-(\d+)", url)
    return int(m.group(1)) if m else 0


def _parse_int(text: str) -> int:
    """Parse an integer from text, ignoring non-digit characters."""
    cleaned = re.sub(r"[^\d]", "", text)
    return int(cleaned) if cleaned else 0


# ═══════════════════════════════════════════════════════════════════════════
# Book ID registry
# ═══════════════════════════════════════════════════════════════════════════


def load_registry() -> dict[str, int]:
    """Load the tf_slug → numeric ID mapping from disk."""
    if REGISTRY_PATH.exists():
        return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    return {}


def save_registry(registry: dict[str, int]) -> None:
    """Persist the tf_slug → numeric ID mapping."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(
        json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def get_or_create_book_id(tf_slug: str, registry: dict[str, int]) -> int:
    """Return the existing ID for *tf_slug* or assign the next sequential one."""
    if tf_slug in registry:
        return registry[tf_slug]
    next_id = ID_OFFSET + len(registry) + 1
    registry[tf_slug] = next_id
    save_registry(registry)
    return next_id


# ── Dedup (checks existing books across all sources) ────────────────────────


def build_existing_index() -> dict[str, dict]:
    """Index existing binslib books by slug for deduplication.

    Returns ``{slug: {"id": int, "name": str, "status": int, "source": str}}``.
    """
    import sqlite3

    if not BINSLIB_DB_PATH.exists():
        return {}
    conn = sqlite3.connect(str(BINSLIB_DB_PATH))
    try:
        rows = conn.execute(
            "SELECT id, name, slug, status, source FROM books WHERE slug IS NOT NULL"
        ).fetchall()
    finally:
        conn.close()
    return {
        slug: {"id": book_id, "name": name, "status": status, "source": source}
        for book_id, name, slug, status, source in rows
        if slug
    }


def is_duplicate(slug: str, name: str, existing_index: dict[str, dict]) -> bool:
    """Return *True* if the book already exists in any source.

    Checks by slug match first, then by exact name match.
    """
    # Check by slug
    if slug in existing_index:
        return True

    # Check by exact name match (different slug, same book)
    name_lower = name.lower().strip()
    for entry in existing_index.values():
        if entry.get("name", "").lower().strip() == name_lower:
            return True

    return False


# ═══════════════════════════════════════════════════════════════════════════
# TFSource
# ═══════════════════════════════════════════════════════════════════════════


class TFSource(BookSource):
    """Book source backed by truyenfull.vision HTML scraping.

    Parameters
    ----------
    max_concurrent:
        Maximum in-flight HTTP requests.
    request_delay:
        Minimum seconds between requests inside the semaphore.
    timeout:
        Per-request read-timeout in seconds.
    """

    def __init__(
        self,
        max_concurrent: int = TF_DEFAULT_MAX_CONCURRENT,
        request_delay: float = TF_DEFAULT_DELAY,
        timeout: float = 30,
    ):
        self._client = _AsyncTFClient(
            delay=request_delay,
            max_concurrent=max_concurrent,
            timeout=timeout,
        )

    # ── Identity ────────────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return "tf"

    # ── Book metadata ───────────────────────────────────────────────────

    async def fetch_book_metadata(self, entry: dict) -> dict | None:
        """Fetch metadata by scraping the book detail page.

        *entry* must contain ``tf_slug`` or ``slug``; ``id`` is preserved.
        """
        tf_slug = entry.get("tf_slug") or entry.get("slug")
        if not tf_slug:
            log.warning("SKIP tf entry without slug: %s", entry.get("id"))
            return None

        try:
            html = await self._client.get_html(f"/{tf_slug}/")
        except TFNotFound:
            log.info("SKIP tf %s: 404", tf_slug)
            return None
        except TFFetchError as exc:
            log.warning("SKIP tf %s: %s", tf_slug, exc)
            return None

        meta = parse_book_detail(html, tf_slug)

        # Carry over the plan-assigned ID, or create one from the registry
        if "id" in entry:
            meta["id"] = entry["id"]
        else:
            registry = load_registry()
            meta["id"] = get_or_create_book_id(tf_slug, registry)

        # Prefer the plan's chapter_count (from the listing page "Chương N"
        # text, which is exact) over the detail page's estimate (which rounds
        # up from pagination: last_page × 50).  E.g. listing says 2489 but
        # detail page estimates 2500.
        plan_ch = entry.get("chapter_count", 0)
        if plan_ch > 0:
            meta["chapter_count"] = plan_ch

        return meta

    # ── Chapter iteration ───────────────────────────────────────────────

    # Batch size for parallel chapter fetching.  Chapters within a batch
    # are fetched concurrently (bounded by the client semaphore), then
    # yielded in index order before starting the next batch.
    # Kept at 10 (not 20) to avoid overwhelming the server — a batch of
    # 20 simultaneous requests frequently triggers 503 responses.
    _FETCH_BATCH_SIZE = 10

    async def fetch_chapters(
        self,
        meta: dict,
        existing_indices: set[int],
        bundle_path: str,
    ) -> AsyncIterator[ChapterData]:
        """Fetch missing chapters in parallel batches.

        Unlike the old sequential approach (one request at a time, ~3 ch/s),
        this fetches ``_FETCH_BATCH_SIZE`` chapters concurrently per batch,
        achieving ~15-60 ch/s depending on server response time and the
        client's ``max_concurrent`` setting.

        Results are yielded in ascending index order within each batch.
        """
        tf_slug = meta.get("tf_slug", meta["slug"])
        chapter_count = meta.get("chapter_count", 0)
        book_id = meta["id"]

        # Collect all missing indices upfront
        to_fetch = sorted(
            idx for idx in range(1, chapter_count + 1) if idx not in existing_indices
        )

        if not to_fetch:
            return

        # Progressive backoff: when a batch has many errors, pause longer
        # before the next batch to let the server recover.
        batch_delay = 0.0  # seconds to wait before starting next batch

        # Process in batches
        for batch_start in range(0, len(to_fetch), self._FETCH_BATCH_SIZE):
            # Inter-batch delay — increases when errors are detected
            if batch_delay > 0:
                await asyncio.sleep(batch_delay)

            batch = to_fetch[batch_start : batch_start + self._FETCH_BATCH_SIZE]

            # Fetch all chapters in this batch concurrently
            results: dict[int, ChapterData | None] = {}

            async def _fetch_one(ch_idx: int) -> None:
                data = await self._fetch_single_chapter(book_id, tf_slug, ch_idx)
                results[ch_idx] = data

            await asyncio.gather(*[_fetch_one(idx) for idx in batch])

            # Count errors in this batch to adjust pacing
            batch_errors = sum(1 for v in results.values() if v is None)
            if batch_errors > len(batch) // 2:
                # More than half failed — server is struggling, back off
                batch_delay = min(batch_delay + 5.0, 30.0)
                log.info(
                    "  [%d] batch %d/%d: %d/%d failed, backing off %.0fs",
                    book_id,
                    batch_start // self._FETCH_BATCH_SIZE + 1,
                    (len(to_fetch) + self._FETCH_BATCH_SIZE - 1)
                    // self._FETCH_BATCH_SIZE,
                    batch_errors,
                    len(batch),
                    batch_delay,
                )
            elif batch_errors == 0 and batch_delay > 0:
                # All succeeded — ease off the backoff
                batch_delay = max(batch_delay - 2.0, 0.0)

            # Yield successful results in index order
            for idx in batch:
                ch = results.get(idx)
                if ch is not None:
                    yield ch

    async def _fetch_single_chapter(
        self,
        book_id: int,
        tf_slug: str,
        ch_idx: int,
    ) -> ChapterData | None:
        """Fetch and parse a single chapter with retry on parse failure.

        Returns ``ChapterData`` on success, ``None`` on failure.
        """
        url = f"/{tf_slug}/chuong-{ch_idx}/"

        # Retry up to 3 times when the server returns 200 but the page
        # is not a chapter (ad interstitial, CAPTCHA, throttle page).
        for _attempt in range(3):
            try:
                html = await self._client.get_html(url)
            except TFNotFound:
                return None  # Real 404 — chapter doesn't exist
            except TFFetchError as exc:
                log.warning("  [%d] chuong-%d: %s", book_id, ch_idx, exc)
                return None  # Network error after retries — skip

            parsed = parse_chapter(html)
            if parsed:
                body = parsed["body"]
                word_count = len(body.split())
                return ChapterData(
                    index=ch_idx,
                    title=parsed["title"],
                    slug=f"chuong-{ch_idx}",
                    body=body,
                    word_count=word_count,
                )

            # Server returned 200 but page has no #chapter-c — likely
            # a throttle/ad page.  Random backoff before retry.
            if _attempt < 2:
                await asyncio.sleep(random.uniform(3, 10))

        return None

    # ── Cover ───────────────────────────────────────────────────────────

    async def download_cover(
        self,
        book_id: int,
        meta: dict,
        covers_dir: str,
    ) -> str | None:
        """Download cover image from the URL in *meta['cover_url']*."""
        dest = os.path.join(covers_dir, f"{book_id}.jpg")
        if os.path.exists(dest):
            return f"/covers/{book_id}.jpg"

        cover_url = meta.get("cover_url", "")
        if not cover_url:
            return None

        try:
            data = await self._client.get_bytes(cover_url)
        except TFFetchError:
            return None

        if len(data) < 100:
            return None

        os.makedirs(covers_dir, exist_ok=True)
        with open(dest, "wb") as f:
            f.write(data)
        return f"/covers/{book_id}.jpg"

    # ── Lifecycle ───────────────────────────────────────────────────────

    async def close(self) -> None:
        await self._client.close()
