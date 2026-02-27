"""TTV source — truyen.tangthuvien.vn HTML scraper.

Fetches book metadata and chapter content from the public TTV website by
parsing server-rendered HTML.  No authentication or decryption required.

The module is self-contained: it includes an async HTTP client with
throttling, HTML parsers for every page type, and a book-ID registry that
assigns 10 000 000+ numeric IDs to TTV slugs (avoiding collisions with MTC
IDs which are < 1 000 000).

Parsers are ported from ``crawler-tangthuvien/src/parser.py``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections.abc import AsyncIterator
from html import unescape
from pathlib import Path

import httpx
from bs4 import BeautifulSoup, Tag

from ..db import slugify as _slugify
from .base import BookSource, ChapterData

log = logging.getLogger("book-ingest.ttv")

# ═══════════════════════════════════════════════════════════════════════════
# Config
# ═══════════════════════════════════════════════════════════════════════════

TTV_BASE_URL = "https://truyen.tangthuvien.vn"

TTV_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
}

TTV_DEFAULT_DELAY = 0.3  # seconds between requests
TTV_DEFAULT_MAX_CONCURRENT = 20

# TTV book IDs start at 10M to avoid collision with MTC IDs (< 1M).
ID_OFFSET = 10_000_000

# TTV author IDs start at 20M to avoid collision with MTC author IDs.
# MTC authors use native API IDs (< 1M) plus synthetic 999xxx IDs.
AUTHOR_ID_OFFSET = 20_000_000

# ── Paths ───────────────────────────────────────────────────────────────────

_INGEST_DIR = Path(__file__).resolve().parent.parent.parent  # book-ingest/
DATA_DIR = _INGEST_DIR / "data"
REGISTRY_PATH = DATA_DIR / "books_registry_ttv.json"
TTV_PLAN_FILE = DATA_DIR / "books_plan_ttv.json"
BINSLIB_DB_PATH = _INGEST_DIR.parent / "binslib" / "data" / "binslib.db"


# ═══════════════════════════════════════════════════════════════════════════
# Async HTTP client
# ═══════════════════════════════════════════════════════════════════════════


class TTVFetchError(Exception):
    """Any non-recoverable HTTP error from TTV."""


class TTVNotFound(TTVFetchError):
    """HTTP 404 from TTV."""


class _AsyncTTVClient:
    """Async HTTP client with semaphore-based throttling and retries.

    Each request acquires the semaphore, sleeps for *delay* seconds, then
    fires.  This caps both concurrency **and** rate.
    """

    def __init__(
        self,
        delay: float = TTV_DEFAULT_DELAY,
        max_concurrent: int = TTV_DEFAULT_MAX_CONCURRENT,
        timeout: float = 30,
        max_retries: int = 3,
    ):
        self._sem = asyncio.Semaphore(max_concurrent)
        self._delay = delay
        self._max_retries = max_retries
        self._client = httpx.AsyncClient(
            headers=TTV_HEADERS,
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
            url = f"{TTV_BASE_URL}{url}"

        retries = retries if retries is not None else self._max_retries

        async with self._sem:
            for attempt in range(retries):
                await asyncio.sleep(self._delay)
                try:
                    r = await self._client.get(url, params=params)
                except httpx.TransportError as exc:
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** (attempt + 1))
                        continue
                    raise TTVFetchError(
                        f"Transport error after {retries} retries: {exc}"
                    ) from exc

                if r.status_code == 429:
                    wait = int(r.headers.get("Retry-After", 2 ** (attempt + 2)))
                    if attempt < retries - 1:
                        await asyncio.sleep(wait)
                        continue
                    raise TTVFetchError(f"Rate limited after {retries} retries")

                if r.status_code == 404:
                    raise TTVNotFound(f"Not found: {url}")

                if r.status_code != 200:
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** (attempt + 1))
                        continue
                    raise TTVFetchError(f"HTTP {r.status_code}: {url}")

                return r

        raise TTVFetchError(f"Failed after {retries} retries: {url}")

    async def get_html(self, url: str, params: dict | None = None) -> str:
        return (await self.get(url, params=params)).text

    async def get_bytes(self, url: str) -> bytes:
        return (await self.get(url)).content


# ═══════════════════════════════════════════════════════════════════════════
# HTML parsers  (ported from crawler-tangthuvien/src/parser.py)
# ═══════════════════════════════════════════════════════════════════════════

# ---------------------------------------------------------------------------
# Listing / ranking page  (/tong-hop)
# ---------------------------------------------------------------------------


def parse_listing_page(html: str) -> list[dict]:
    """Parse a ``/tong-hop`` listing page and return book entries.

    Each entry has keys: ``slug``, ``name``, ``author_name``, ``author_id``,
    ``genre``, ``status_text``, ``chapter_count``, ``synopsis``,
    ``updated_at``, ``cover_url``, ``ttv_book_id``.
    """
    soup = BeautifulSoup(html, "lxml")
    books: list[dict] = []
    for li in soup.select("div.rank-view-list li"):
        try:
            book = _parse_listing_item(li)
            if book:
                books.append(book)
        except Exception:
            continue
    return books


def parse_listing_total_pages(html: str) -> int:
    """Extract the last page number from pagination links."""
    soup = BeautifulSoup(html, "lxml")
    max_page = 1
    for a in soup.select("div.pagination ul.pagination li a"):
        m = re.search(r"page=(\d+)", str(a.get("href", "")))
        if m:
            max_page = max(max_page, int(m.group(1)))
    return max_page


def _parse_listing_item(li: Tag) -> dict | None:
    title_a = li.select_one("div.book-mid-info h4 a")
    if not title_a:
        return None

    href = title_a.get("href", "")
    slug = _extract_slug(href)
    name = title_a.get_text(strip=True)

    author_a = li.select_one("p.author a.name")
    author_name = author_a.get_text(strip=True) if author_a else ""
    author_id = _extract_author_id(author_a.get("href", "")) if author_a else None

    genre_a = li.select_one("p.author a[href*='the-loai']")
    genre = genre_a.get_text(strip=True) if genre_a else ""

    status_text = ""
    chapter_count = 0
    for span in li.select("p.author > span"):
        text = span.get_text(strip=True)
        if "chương" in text:
            m = re.search(r"(\d+)", text)
            if m:
                chapter_count = int(m.group(1))
        elif text in ("Đang ra", "Đã hoàn thành", "Hoàn thành", "Tạm dừng"):
            status_text = text

    if chapter_count == 0:
        for span in li.select("p.author span span"):
            text = span.get_text(strip=True)
            if text.isdigit():
                chapter_count = int(text)
                break

    intro_p = li.select_one("p.intro")
    synopsis = intro_p.get_text(strip=True) if intro_p else ""

    update_span = li.select_one("p.update span")
    updated_at = update_span.get_text(strip=True) if update_span else ""

    img = li.select_one("div.book-img-box img")
    cover_url = img.get("src", "") if img else ""

    detail_a = li.select_one("a.blue-btn[data-bookid]")
    ttv_book_id = detail_a.get("data-bookid") if detail_a else None

    return {
        "slug": _slugify(unescape(name)) or slug,
        "ttv_slug": slug,
        "name": unescape(name),
        "author_name": unescape(author_name),
        "author_id": author_id,
        "genre": unescape(genre),
        "status_text": unescape(status_text),
        "chapter_count": chapter_count,
        "synopsis": unescape(synopsis),
        "updated_at": updated_at,
        "cover_url": cover_url,
        "ttv_book_id": ttv_book_id,
    }


# ---------------------------------------------------------------------------
# Book detail page  (/doc-truyen/{slug})
# ---------------------------------------------------------------------------


def parse_book_detail(html: str, slug: str) -> dict:
    """Parse a book detail page and return metadata.

    The returned dict is shaped for :func:`src.db.upsert_book_metadata`
    (minus ``id`` which the caller must set).
    """
    soup = BeautifulSoup(html, "lxml")

    # Title
    h1 = soup.select_one("div.book-info h1")
    name = h1.get_text(strip=True) if h1 else slug

    # Author
    author_a = soup.select_one("div.book-info p.tag a[href*='tac-gia']")
    author_name = author_a.get_text(strip=True) if author_a else ""
    author_id = _extract_author_id(author_a.get("href", "")) if author_a else None

    # Status
    status_span = soup.select_one("div.book-info p.tag span.blue")
    status_text = status_span.get_text(strip=True) if status_span else ""
    status = _map_status(status_text)

    # Genres
    genre_links = soup.select("div.book-info p.tag a[href*='the-loai']")
    genres: list[dict] = []
    for a in genre_links:
        genre_href = a.get("href", "")
        genre_slug = genre_href.rstrip("/").split("/")[-1] if genre_href else ""
        genres.append({"name": a.get_text(strip=True), "slug": genre_slug})

    # Synopsis
    full_intro = soup.select_one("div.book-info-detail div.book-intro p")
    if full_intro:
        synopsis_html = (
            full_intro.decode_contents().replace("<br/>", "\n").replace("<br>", "\n")
        )
        synopsis = BeautifulSoup(synopsis_html, "lxml").get_text(strip=True)
    else:
        intro_p = soup.select_one("div.book-info p.intro")
        if not intro_p:
            intro_p = soup.select_one("div.book-intro p")
        synopsis = intro_p.get_text(strip=True) if intro_p else ""

    # Stats
    view_count = _parse_stat(soup, "ULtwOOTH-view")
    bookmark_count = _parse_stat(soup, "ULtwOOTH-like")
    follow_count = _parse_stat(soup, "ULtwOOTH-follow")
    vote_count = _parse_stat(soup, "ULtwOOTH-nomi")

    # Rating
    rate_el = soup.select_one("cite#myrate")
    review_score = float(rate_el.get_text(strip=True)) if rate_el else 0.0

    rating_count_el = soup.select_one("span#myrating")
    review_count = (
        _parse_int(rating_count_el.get_text(strip=True)) if rating_count_el else 0
    )

    # Chapter count from tab label
    catalog_tab = soup.select_one("a#j-bookCatalogPage")
    chapter_count = 0
    if catalog_tab:
        m = re.search(r"(\d+)\s*chương", catalog_tab.get_text())
        if m:
            chapter_count = int(m.group(1))

    # Cover image
    cover_img = soup.select_one("div.book-img img")
    cover_url = cover_img.get("src", "") if cover_img else ""
    if not cover_url or "default-book" in cover_url:
        og_img = soup.select_one('meta[property="og:image"]')
        if og_img:
            cover_url = og_img.get("content", "")

    # TTV internal story ID
    story_id_input = soup.select_one("input#story_id_hidden")
    ttv_story_id = story_id_input.get("value") if story_id_input else None
    if not ttv_story_id:
        meta_detail = soup.select_one('meta[name="book_detail"]')
        if meta_detail:
            ttv_story_id = meta_detail.get("content")

    # Dates from JSON-LD
    date_published = ""
    date_modified = ""
    ld_script = soup.select_one('script[type="application/ld+json"]')
    if ld_script:
        try:
            ld = json.loads(ld_script.string)
            date_published = ld.get("datePublished", "")
            date_modified = ld.get("dateModified", "")
        except (json.JSONDecodeError, TypeError):
            pass

    return {
        "name": unescape(name),
        "slug": _slugify(unescape(name)) or slug,
        "ttv_slug": slug,
        "synopsis": unescape(synopsis),
        "status": status,
        "status_name": unescape(status_text),
        "view_count": view_count,
        "comment_count": 0,
        "bookmark_count": bookmark_count,
        "vote_count": vote_count,
        "follow_count": follow_count,
        "review_score": review_score,
        "review_count": review_count,
        "chapter_count": chapter_count,
        "word_count": 0,
        "cover_url": cover_url,
        "author": {"id": author_id, "name": unescape(author_name)},
        "genres": genres,
        "tags": [],
        "created_at": date_published,
        "updated_at": date_modified,
        "published_at": date_published,
        "new_chap_at": None,
        "ttv_story_id": ttv_story_id,
        "source": "ttv",
    }


# ---------------------------------------------------------------------------
# Chapter page  (/doc-truyen/{slug}/chuong-{N})
# ---------------------------------------------------------------------------


def parse_chapter(html: str) -> dict | None:
    """Parse a chapter page.

    Returns ``{"title": str, "body": str}`` or ``None`` if the page
    does not contain chapter content.

    The ``<h2>`` element provides the canonical chapter title.  The body
    is extracted from ``div.box-chap`` elements with two dedup steps:

    1. ``<h5>`` tags inside ``box-chap`` (which duplicate the title) are
       removed before text extraction.
    2. If the first non-empty line of the body matches the title, it is
       stripped to avoid duplication in the reader UI — same fix applied
       to MTC chapters in ``decrypt_chapter()``.
    """
    soup = BeautifulSoup(html, "lxml")

    h2 = soup.select_one("h2")
    if not h2:
        return None
    title = h2.get_text(strip=True).replace("\xa0", " ")

    box_chaps = soup.select("div.box-chap")
    if not box_chaps:
        return None

    # Remove embedded <h5> headings that duplicate the chapter title
    for box in box_chaps:
        for h5 in box.find_all("h5"):
            h5.decompose()

    paragraphs: list[str] = []
    for box in box_chaps:
        text = box.get_text(separator="\n").strip()
        if text:
            paragraphs.append(text)

    body = "\n\n".join(paragraphs)
    if not body:
        return None

    # Strip leading text that matches the chapter title (same dedup as MTC).
    # TTV pages embed the title in the body in two ways:
    #   a) As a separate line:  "Chương 1: Kim Biên hoa\nBody text..."
    #   b) As a prefix on the same line: "Chương 1: Kim Biên hoa  Body text..."
    # We handle both by checking for exact-line match first, then prefix match.
    title_clean = unescape(title)
    norm = lambda s: re.sub(r"\s*:\s*", ": ", s).strip()
    title_norm = norm(title_clean)

    lines = body.split("\n")
    body_start = 0

    # Skip leading empty lines
    while body_start < len(lines) and lines[body_start].strip() == "":
        body_start += 1

    if body_start < len(lines):
        first_line = lines[body_start].strip()
        first_norm = norm(first_line)

        if first_line == title_clean or first_norm == title_norm:
            # Case (a): title is the entire line — drop it
            body_start += 1
        elif first_norm.startswith(title_norm):
            # Case (b): title is a prefix — strip it, keep the rest
            remainder = first_line[len(title_clean) :].strip()
            # Also try stripping with normalised colon spacing
            if not remainder:
                raw_prefix_len = len(title_clean)
                # Try matching with flexible whitespace around colon
                m = re.match(
                    re.escape(title_norm).replace(r":\ ", r"\s*:\s*"),
                    first_line,
                )
                if m:
                    remainder = first_line[m.end() :].strip()
            if remainder:
                lines[body_start] = remainder
            else:
                body_start += 1

    body = "\n".join(lines[body_start:]).strip()

    return {"title": title_clean, "body": body}


# ---------------------------------------------------------------------------
# Parser helpers
# ---------------------------------------------------------------------------


def _extract_slug(url: str) -> str:
    """``/doc-truyen/muc-than-ky`` → ``muc-than-ky``"""
    path = url.rstrip("/").split("/doc-truyen/")[-1] if "/doc-truyen/" in url else ""
    return path.split("?")[0]


def _extract_author_id(url: str) -> int | None:
    """Extract author ID from a TTV URL and apply the 20M offset.

    The offset prevents collision with MTC author IDs which share
    the same ``authors`` table.  E.g. TTV author 357 becomes 20000357.
    """
    m = re.search(r"author=(\d+)", url)
    if not m:
        return None
    return int(m.group(1)) + AUTHOR_ID_OFFSET


def _extract_chapter_index(url: str) -> int:
    """``/doc-truyen/slug/chuong-5`` → ``5``"""
    m = re.search(r"chuong-(\d+)", url)
    return int(m.group(1)) if m else 0


def _parse_stat(soup: BeautifulSoup, class_fragment: str) -> int:
    el = soup.select_one(f"span[class*='{class_fragment}']")
    return _parse_int(el.get_text(strip=True)) if el else 0


def _parse_int(text: str) -> int:
    cleaned = re.sub(r"[^\d]", "", text)
    return int(cleaned) if cleaned else 0


def _map_status(text: str) -> int:
    """Map Vietnamese status text to numeric code (1=ongoing, 2=done, 3=paused)."""
    t = text.lower().strip()
    if "hoàn thành" in t or "hoan thanh" in t:
        return 2
    if "tạm dừng" in t or "tam dung" in t:
        return 3
    return 1


# ═══════════════════════════════════════════════════════════════════════════
# Book ID registry  (ported from crawler-tangthuvien/src/utils.py)
# ═══════════════════════════════════════════════════════════════════════════


def load_registry() -> dict[str, int]:
    """Load the slug → numeric ID mapping from disk."""
    if REGISTRY_PATH.exists():
        return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    return {}


def save_registry(registry: dict[str, int]) -> None:
    """Persist the slug → numeric ID mapping."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(
        json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def get_or_create_book_id(slug: str, registry: dict[str, int]) -> int:
    """Return the existing ID for *slug* or assign the next sequential one."""
    if slug in registry:
        return registry[slug]
    next_id = ID_OFFSET + len(registry) + 1
    registry[slug] = next_id
    save_registry(registry)
    return next_id


# ── MTC deduplication (for plan generation) ─────────────────────────────────


def build_mtc_index() -> dict[str, dict]:
    """Index existing binslib books by slug for deduplication.

    Returns ``{slug: {"id": int, "name": str, "status": int}}``.
    """
    import sqlite3

    if not BINSLIB_DB_PATH.exists():
        return {}
    conn = sqlite3.connect(str(BINSLIB_DB_PATH))
    try:
        rows = conn.execute(
            "SELECT id, name, slug, status FROM books WHERE slug IS NOT NULL"
        ).fetchall()
    finally:
        conn.close()
    return {
        slug: {"id": book_id, "name": name, "status": status}
        for book_id, name, slug, status in rows
        if slug
    }


def is_mtc_duplicate(slug: str, mtc_index: dict[str, dict]) -> bool:
    """Return *True* if the slug matches a completed (status=2) MTC book."""
    entry = mtc_index.get(slug)
    return entry is not None and entry.get("status") == 2


# ═══════════════════════════════════════════════════════════════════════════
# TTVSource
# ═══════════════════════════════════════════════════════════════════════════


class TTVSource(BookSource):
    """Book source backed by truyen.tangthuvien.vn HTML scraping.

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
        max_concurrent: int = TTV_DEFAULT_MAX_CONCURRENT,
        request_delay: float = TTV_DEFAULT_DELAY,
        timeout: float = 30,
    ):
        self._client = _AsyncTTVClient(
            delay=request_delay,
            max_concurrent=max_concurrent,
            timeout=timeout,
        )

    # ── Identity ────────────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return "ttv"

    # ── Book metadata ───────────────────────────────────────────────────

    async def fetch_book_metadata(self, entry: dict) -> dict | None:
        """Fetch metadata by scraping the book detail page.

        *entry* must contain ``slug``; ``id`` is preserved as-is.  If ``id``
        is missing, one will be assigned from the registry.
        """
        # Prefer ttv_slug (original TTV URL slug, may contain diacritics)
        # over slug (ASCII-clean, for DB/website) for fetching from TTV.
        ttv_slug = entry.get("ttv_slug") or entry.get("slug")
        if not ttv_slug:
            log.warning("SKIP ttv entry without slug: %s", entry.get("id"))
            return None

        try:
            html = await self._client.get_html(f"/doc-truyen/{ttv_slug}")
        except TTVNotFound:
            log.info("SKIP ttv %s: 404", ttv_slug)
            return None
        except TTVFetchError as exc:
            log.warning("SKIP ttv %s: %s", ttv_slug, exc)
            return None

        meta = parse_book_detail(html, ttv_slug)

        # Carry over the plan-assigned ID, or create one from the registry
        if "id" in entry:
            meta["id"] = entry["id"]
        else:
            registry = load_registry()
            meta["id"] = get_or_create_book_id(slug, registry)

        return meta

    # ── Chapter iteration ───────────────────────────────────────────────

    async def fetch_chapters(
        self,
        meta: dict,
        existing_indices: set[int],
        bundle_path: str,
    ) -> AsyncIterator[ChapterData]:
        """Iterate ``chuong-1`` … ``chuong-N``, skipping existing indices.

        TTV serves chapters at predictable URLs, so the walk is a simple
        sequential loop — no linked-list traversal or resume logic needed.
        """
        # Use the original TTV slug for URLs (may contain diacritics);
        # meta["slug"] is the ASCII-clean version for DB storage.
        ttv_slug = meta.get("ttv_slug", meta["slug"])
        chapter_count = meta.get("chapter_count", 0)
        book_id = meta["id"]

        for ch_idx in range(1, chapter_count + 1):
            if ch_idx in existing_indices:
                continue

            url = f"/doc-truyen/{ttv_slug}/chuong-{ch_idx}"
            try:
                html = await self._client.get_html(url)
            except TTVNotFound:
                log.warning("  [%d] chuong-%d: 404", book_id, ch_idx)
                continue
            except TTVFetchError as exc:
                log.warning("  [%d] chuong-%d: %s", book_id, ch_idx, exc)
                continue

            parsed = parse_chapter(html)
            if not parsed:
                log.warning("  [%d] chuong-%d: parser returned None", book_id, ch_idx)
                continue

            body = parsed["body"]
            word_count = len(body.split())

            yield ChapterData(
                index=ch_idx,
                title=parsed["title"],
                slug=f"chuong-{ch_idx}",
                body=body,
                word_count=word_count,
                # chapter_id stays 0 — TTV has no API chapter IDs
            )

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
        if not cover_url or "default-book" in cover_url:
            return None

        try:
            data = await self._client.get_bytes(cover_url)
        except TTVFetchError:
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
