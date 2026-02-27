#!/usr/bin/env python3
"""Generate and maintain the book-ingest download plan.

Combines catalog discovery, per-book metadata enrichment, ID-range scanning,
and cover image downloading into a single tool.

Modes:

  Default (no flags)    Paginate the API catalog, cross-reference with local
                        bundles, write a fresh plan, then pull missing covers.

  --refresh             Read the existing plan file, fetch full per-book
                        metadata from the API (author, genres, tags, synopsis,
                        poster, stats), and write an enriched plan.  Detects
                        removed books (404) and new chapters.

  --scan                (requires --refresh) Also probe every ID in the MTC
                        range to discover books invisible to the catalog
                        listing endpoint.

  --cover-only          Only download missing cover images; skip plan
                        generation entirely.

Usage:
    python3 generate_plan.py                                # catalog → plan + covers
    python3 generate_plan.py --refresh                      # enrich existing plan
    python3 generate_plan.py --refresh --scan               # enrich + discover missing
    python3 generate_plan.py --refresh --scan               # + synthetic authors (default)
    python3 generate_plan.py --refresh --no-fix-author      # disable synthetic authors
    python3 generate_plan.py --cover-only                   # covers only
    python3 generate_plan.py --cover-only --ids 132599 131197
    python3 generate_plan.py --cover-only --force           # re-download all
    python3 generate_plan.py --dry-run                      # preview, no writes
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import httpx
from rich.console import Console
from rich.panel import Panel
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)
from rich.table import Table

# ── API config ──────────────────────────────────────────────────────────────

BASE_URL = "https://android.lonoapp.net"
BEARER_TOKEN = os.environ.get(
    "MTC_BEARER_TOKEN",
    "7045826|W0GmBOqfeWO0wWZUD7QpikPjvMsP1tq7Ayjq48pX",
)
HEADERS = {
    "authorization": f"Bearer {BEARER_TOKEN}",
    "x-app": "app.android",
    "user-agent": "Dart/3.5 (dart:io)",
    "content-type": "application/json",
}
REQUEST_DELAY = 0.3

# ── Paths ───────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent
BINSLIB_DIR = SCRIPT_DIR.parent / "binslib"
COMPRESSED_DIR = BINSLIB_DIR / "data" / "compressed"
COVERS_DIR = BINSLIB_DIR / "public" / "covers"
PLAN_DIR = SCRIPT_DIR / "data"
PLAN_FILE = PLAN_DIR / "books_plan_mtc.json"
TTV_PLAN_FILE = PLAN_DIR / "books_plan_ttv.json"
TF_PLAN_FILE = PLAN_DIR / "books_plan_tf.json"
AUDIT_FILE = PLAN_DIR / "catalog_audit.json"

# ── Scan config ─────────────────────────────────────────────────────────────

# Default minimum chapter count — filters small/empty books from the plan.
MIN_CHAPTER_COUNT = 100

# ID range for the MTC platform.  Valid book IDs fall within this range.
ID_RANGE_START = 100003
ID_RANGE_END = 153500  # generous upper bound; --scan auto-detects the real max

# ── Console ─────────────────────────────────────────────────────────────────

console = Console()

# ── Bundle helpers (minimal BLIB reader) ────────────────────────────────────

BUNDLE_MAGIC = b"BLIB"
_HEADER_MIN = 12
_ENTRY_SIZE = 16


def read_bundle_chapter_count(bundle_path: Path) -> int:
    """Read the chapter count from a BLIB bundle header (v1 or v2)."""
    try:
        with open(bundle_path, "rb") as f:
            hdr = f.read(_HEADER_MIN)
            if len(hdr) < _HEADER_MIN or hdr[:4] != BUNDLE_MAGIC:
                return 0
            return struct.unpack_from("<I", hdr, 8)[0]
    except OSError:
        return 0


def get_bundle_book_ids() -> list[int]:
    """Scan binslib/data/compressed/ for .bundle files, return sorted IDs."""
    ids: list[int] = []
    if not COMPRESSED_DIR.is_dir():
        return ids
    for f in COMPRESSED_DIR.iterdir():
        if f.suffix == ".bundle" and f.stem.isdigit():
            ids.append(int(f.stem))
    return sorted(ids)


def get_bundle_chapter_counts() -> dict[int, int]:
    """Return {book_id: chapter_count} for all local bundles."""
    counts: dict[int, int] = {}
    if not COMPRESSED_DIR.is_dir():
        return counts
    for f in COMPRESSED_DIR.iterdir():
        if f.suffix == ".bundle" and f.stem.isdigit():
            bid = int(f.stem)
            count = read_bundle_chapter_count(f)
            if count > 0:
                counts[bid] = count
    return counts


# ── API: metadata parsing ───────────────────────────────────────────────────


def _unwrap_book(data: dict) -> dict | None:
    """Unwrap the varying API response shapes into a flat book dict."""
    if isinstance(data, list):
        if not data:
            return None
        item = data[0]
        return item.get("book", item)
    if isinstance(data, dict) and "book" in data:
        return data["book"]
    return data


def _parse_author(raw: dict | None) -> dict | None:
    if not raw or not isinstance(raw, dict):
        return None
    aid = raw.get("id")
    if aid is None:
        return None
    return {
        "id": aid,
        "name": raw.get("name", ""),
        "local_name": raw.get("local_name"),
        "avatar": raw.get("avatar"),
    }


def _parse_creator(raw: dict | None) -> dict | None:
    if not raw or not isinstance(raw, dict):
        return None
    cid = raw.get("id")
    if cid is None:
        return None
    return {"id": cid, "name": raw.get("name", "")}


def _parse_genres(raw: list | None) -> list[dict]:
    if not raw or not isinstance(raw, list):
        return []
    return [
        {"id": g["id"], "name": g.get("name", ""), "slug": g.get("slug", "")}
        for g in raw
        if isinstance(g, dict) and "id" in g
    ]


def _parse_tags(raw: list | None) -> list[dict]:
    if not raw or not isinstance(raw, list):
        return []
    return [
        {"id": t["id"], "name": t.get("name", ""), "type_id": t.get("type_id")}
        for t in raw
        if isinstance(t, dict) and "id" in t
    ]


def _parse_poster(raw: dict | str | None) -> dict | None:
    if isinstance(raw, dict):
        return {k: raw.get(k) for k in ("default", "600", "300", "150")}
    if isinstance(raw, str):
        return {"default": raw, "600": None, "300": None, "150": None}
    return None


# Author names that are placeholders, not real names.
_PLACEHOLDER_AUTHOR_NAMES = {"đang cập nhật"}


def _author_needs_fix(author: dict | None) -> bool:
    """Return True if the author is missing, has an empty name, or a placeholder."""
    if not author:
        return True
    name = author.get("name")
    if not name or not str(name).strip():
        return True
    if str(name).strip().lower() in _PLACEHOLDER_AUTHOR_NAMES:
        return True
    return False


def generate_author_from_creator(creator: dict | None) -> dict | None:
    """Create a synthetic author from a creator (uploader).

    ID is prefixed with 999 to avoid collisions with real author IDs.
    E.g. creator id=1000043 → author id=9991000043.
    """
    if not creator or not creator.get("id"):
        return None
    return {
        "id": int(f"999{creator['id']}"),
        "name": creator["name"],
        "local_name": None,
        "avatar": None,
    }


def parse_book_full(data: dict, fix_author: bool = False) -> dict | None:
    """Parse a full book entry from the API response (per-book endpoint).

    Includes author, creator, genres, tags, synopsis, poster, and all stat
    fields.  Used by --refresh mode.
    """
    book = _unwrap_book(data)
    if not isinstance(book, dict) or "id" not in book:
        return None

    chapter_count = book.get("chapter_count") or book.get("latest_index") or 0
    first_chapter = book.get("first_chapter")
    status_name = book.get("status_name") or book.get("state") or "?"

    author = _parse_author(book.get("author"))
    creator = _parse_creator(book.get("creator"))

    author_generated = False
    if fix_author and _author_needs_fix(author) and creator:
        author = generate_author_from_creator(creator)
        author_generated = True

    review_score = book.get("review_score")
    if isinstance(review_score, str):
        try:
            review_score = float(review_score)
        except ValueError:
            review_score = 0
    review_score = review_score or 0

    return {
        "id": book["id"],
        "name": book.get("name", "?"),
        "slug": book.get("slug", ""),
        "synopsis": book.get("synopsis"),
        "chapter_count": chapter_count,
        "first_chapter": first_chapter,
        "latest_chapter": book.get("latest_chapter"),
        "status": status_name,
        "kind": book.get("kind"),
        "sex": book.get("sex"),
        "word_count": book.get("word_count", 0),
        "view_count": book.get("view_count", 0),
        "vote_count": book.get("vote_count", 0),
        "bookmark_count": book.get("bookmark_count", 0),
        "comment_count": book.get("comment_count", 0),
        "review_score": review_score,
        "review_count": book.get("review_count", 0),
        "poster": _parse_poster(book.get("poster")),
        "author": author,
        "author_generated": author_generated,
        "creator": creator,
        "genres": _parse_genres(book.get("genres")),
        "tags": _parse_tags(book.get("tags")),
        "created_at": book.get("created_at"),
        "updated_at": book.get("updated_at"),
        "published_at": book.get("published_at"),
        "new_chap_at": book.get("new_chap_at"),
    }


def parse_book_lite(item: dict) -> dict:
    """Parse a lightweight entry from the catalog listing endpoint.

    The /api/books listing returns less data than the per-book endpoint;
    this extracts what's available for the initial plan.
    """
    return {
        "id": item["id"],
        "name": item.get("name", "?"),
        "slug": item.get("slug", ""),
        "chapter_count": item.get("latest_index", 0),
        "first_chapter": item.get("first_chapter"),
        "status": item.get("status_name", "?"),
        "kind": item.get("kind"),
        "sex": item.get("sex"),
        "word_count": item.get("word_count", 0),
    }


# ── API: sync fetchers (catalog pagination, single-book) ───────────────────


def fetch_book_metadata_sync(client: httpx.Client, book_id: int) -> dict | None:
    """Fetch full book metadata by ID (synchronous). Returns raw API data."""
    try:
        r = client.get(
            f"{BASE_URL}/api/books/{book_id}",
            params={"include": "author,creator,genres"},
        )
        if r.status_code == 200:
            data = r.json()
            if data.get("success") and data.get("data"):
                return data["data"]
    except Exception as e:
        console.print(f"    [dim]/api/books/{book_id}: {e}[/dim]")
    return None


def fetch_catalog(
    client: httpx.Client, limit: int = 50, log=console.print
) -> list[dict]:
    """Paginate through /api/books to get every book on the platform."""
    all_books: list[dict] = []
    page = 1
    total = None
    last_page = "?"

    while True:
        r = client.get(f"{BASE_URL}/api/books", params={"limit": limit, "page": page})
        data = r.json()
        if not data.get("success"):
            log(f"  Page {page}: API error — {data.get('message', '?')}")
            break

        items = data.get("data", [])
        if not items:
            break

        pag = data.get("pagination", {})
        if total is None:
            total = pag.get("total", "?")
            last_page = pag.get("last", "?")
            log(f"  Total books: {total}, pages: {last_page}")

        for item in items:
            all_books.append(parse_book_lite(item))

        if page % 50 == 0 or page == 1:
            log(f"  Page {page}/{last_page}: {len(all_books)} books collected")

        if not pag.get("next"):
            break
        page += 1
        time.sleep(0.08)

    log(f"  Done: {len(all_books)} books fetched")
    return all_books


# ── API: async fetchers (for --refresh and --scan) ──────────────────────────


async def fetch_book_async(
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    book_id: int,
    delay: float,
    fix_author: bool = False,
    retries: int = 3,
) -> dict | None:
    """Fetch and parse metadata for a single book (async)."""
    for attempt in range(retries):
        async with sem:
            await asyncio.sleep(delay)
            try:
                r = await client.get(
                    f"{BASE_URL}/api/books/{book_id}",
                    params={"include": "author,creator,genres"},
                )
            except httpx.TransportError:
                if attempt < retries - 1:
                    await asyncio.sleep(2 ** (attempt + 1))
                    continue
                return None

        if r.status_code == 404:
            return None
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", 2 ** (attempt + 2)))
            if attempt < retries - 1:
                await asyncio.sleep(wait)
                continue
            return None
        if r.status_code != 200:
            if attempt < retries - 1:
                await asyncio.sleep(2 ** (attempt + 1))
                continue
            return None

        data = r.json()
        if not data.get("success"):
            return None
        return parse_book_full(data.get("data", {}), fix_author=fix_author)

    return None


async def _fetch_batch(
    book_ids: list[int],
    workers: int,
    delay: float,
    label: str,
    fix_author: bool = False,
) -> dict[int, dict | None]:
    """Fetch metadata for a batch of book IDs. Returns {id: entry_or_None}."""
    results: dict[int, dict | None] = {}
    results_lock = asyncio.Lock()
    sem = asyncio.Semaphore(workers)
    total = len(book_ids)
    progress = {"done": 0}
    start = time.time()

    async with httpx.AsyncClient(headers=HEADERS, timeout=30) as client:

        async def _do(bid: int) -> None:
            entry = await fetch_book_async(
                client, sem, bid, delay, fix_author=fix_author
            )
            async with results_lock:
                results[bid] = entry
                progress["done"] += 1

            done = progress["done"]
            if done % 500 == 0 or done == total:
                elapsed = time.time() - start
                rate = done / elapsed if elapsed > 0 else 0
                eta = (total - done) / rate if rate > 0 else 0
                console.print(
                    f"  {label} [{done:,}/{total:,}] {rate:.0f}/s, ETA {eta:.0f}s"
                )

        tasks = [_do(bid) for bid in book_ids]
        await asyncio.gather(*tasks)

    return results


async def find_upper_bound(workers: int, delay: float) -> int:
    """Probe above ID_RANGE_END to find the true upper boundary."""
    probe_ids = list(range(ID_RANGE_END - 500, ID_RANGE_END + 1000, 50))
    results = await _fetch_batch(probe_ids, workers, delay, "probe")
    last_valid = ID_RANGE_END
    for bid in sorted(results):
        if results[bid] is not None:
            last_valid = max(last_valid, bid)
    return last_valid + 100


async def scan_missing_ids(
    known_ids: set[int],
    workers: int,
    delay: float,
    upper_bound: int,
    fix_author: bool = False,
) -> list[dict]:
    """Scan the full ID range and return entries for books not in known_ids."""
    to_probe = [
        bid for bid in range(ID_RANGE_START, upper_bound + 1) if bid not in known_ids
    ]
    if not to_probe:
        console.print("  No IDs to scan — plan already covers the full range.")
        return []

    console.print(
        f"  Scanning {len(to_probe):,} unknown IDs ({ID_RANGE_START}–{upper_bound})..."
    )
    results = await _fetch_batch(
        to_probe, workers, delay, "scan", fix_author=fix_author
    )

    discovered: list[dict] = []
    for bid, entry in results.items():
        if (
            entry is not None
            and entry.get("first_chapter")
            and entry.get("chapter_count", 0) > 0
        ):
            discovered.append(entry)

    return discovered


# ── Stats ───────────────────────────────────────────────────────────────────


@dataclass
class RefreshStats:
    total: int = 0
    updated: int = 0
    unchanged: int = 0
    removed: int = 0
    errors: int = 0
    new_chapters: int = 0
    discovered: int = 0


# ── Cover downloading ──────────────────────────────────────────────────────


def download_cover_image(
    client: httpx.Client, poster: dict | str | None, dest_path: str
) -> bool:
    """Download the best available cover image.

    poster may be a dict with size keys ('default', '600', '300', '150')
    or a plain URL string.
    """
    if not poster:
        return False

    if isinstance(poster, dict):
        for key in ("default", "600", "300", "150"):
            url = poster.get(key)
            if not url:
                continue
            try:
                r = client.get(url, follow_redirects=True, timeout=30)
                if r.status_code == 200 and len(r.content) > 100:
                    with open(dest_path, "wb") as f:
                        f.write(r.content)
                    return True
            except Exception:
                continue
        return False

    if isinstance(poster, str):
        try:
            r = client.get(poster, follow_redirects=True, timeout=30)
            if r.status_code == 200 and len(r.content) > 100:
                with open(dest_path, "wb") as f:
                    f.write(r.content)
                return True
        except Exception:
            pass

    return False


def pull_cover_for_book(client: httpx.Client, book_id: int, log=console.print) -> bool:
    """Download a cover image directly to binslib/public/covers/{book_id}.jpg.

    Fetches the poster URL from the API (one request per book).
    """
    dest_path = str(COVERS_DIR / f"{book_id}.jpg")

    raw = fetch_book_metadata_sync(client, book_id)
    if not raw:
        log(f"  [red]FAILED[/red] {book_id}: no API data")
        return False

    book = _unwrap_book(raw) if isinstance(raw, dict) else raw
    if not book:
        log(f"  [red]FAILED[/red] {book_id}: bad response shape")
        return False

    poster = _parse_poster(book.get("poster") if isinstance(book, dict) else None)
    if not poster:
        log(f"  [yellow]WARNING[/yellow] {book_id}: no poster info")
        return False

    return download_cover_image(client, poster, dest_path)


def run_cover_pull(
    target_ids: list[int], force: bool, dry_run: bool, delay: float
) -> None:
    """Download missing covers for the given book IDs."""
    COVERS_DIR.mkdir(parents=True, exist_ok=True)

    if force:
        pending = target_ids
    else:
        pending = [
            bid for bid in target_ids if not (COVERS_DIR / f"{bid}.jpg").exists()
        ]

    console.print(f"  Targeted:       [bold]{len(target_ids)}[/bold]")
    console.print(f"  Missing covers: [bold]{len(pending)}[/bold]")
    console.print(f"  Destination:    [dim]{COVERS_DIR}[/dim]")
    console.print()

    if not pending:
        console.print("[green]All covers present. Nothing to do.[/green]")
        return

    if dry_run:
        console.print("[yellow]Dry run — would download covers for:[/yellow]")
        for bid in pending[:30]:
            console.print(f"  {bid}")
        if len(pending) > 30:
            console.print(f"  [dim]... and {len(pending) - 30} more[/dim]")
        return

    succeeded = 0
    failed = 0

    progress = Progress(
        TextColumn("[bold blue]{task.description}"),
        BarColumn(bar_width=30),
        MofNCompleteColumn(),
        TextColumn("•"),
        TimeElapsedColumn(),
        TextColumn("•"),
        TimeRemainingColumn(),
    )

    with progress, httpx.Client(headers=HEADERS, timeout=30) as client:
        task = progress.add_task("Pulling covers", total=len(pending))

        for i, bid in enumerate(pending, 1):
            progress.update(task, description=f"Cover {bid}")

            if pull_cover_for_book(client, bid, log=progress.console.print):
                succeeded += 1
            else:
                failed += 1

            progress.advance(task)

            if i < len(pending):
                time.sleep(delay)

    console.print(
        f"\nDone: [green]{succeeded}[/green] succeeded, "
        f"[red]{failed}[/red] failed out of {len(pending)}"
    )


# ── Mode: generate (catalog pagination → plan) ─────────────────────────────


def run_generate(dry_run: bool = False) -> list[dict]:
    """Paginate the API catalog, cross-ref with local bundles, write plan.

    This is the fast path: uses the /api/books listing endpoint which returns
    lightweight entries.  Good for a quick initial plan; use --refresh to
    enrich with full per-book metadata afterward.
    """
    console.print("\n[bold blue]Fetching API catalog...[/bold blue]")
    with httpx.Client(headers=HEADERS, timeout=30) as client:
        catalog = fetch_catalog(client)

    # Build local chapter counts from bundles
    console.print("[bold blue]Scanning local bundles...[/bold blue]")
    known_bids = get_bundle_chapter_counts()
    console.print(f"  Local bundles: {len(known_bids)}")

    # Classify catalog entries
    downloadable = [
        b for b in catalog if b.get("first_chapter") and b.get("chapter_count", 0) > 0
    ]
    not_downloadable = [
        b
        for b in catalog
        if not b.get("first_chapter") or b.get("chapter_count", 0) == 0
    ]

    have_complete: list[dict] = []
    have_partial: list[dict] = []
    need_download: list[dict] = []

    for b in downloadable:
        bid = b["id"]
        api_ch = b["chapter_count"]
        local_ch = known_bids.get(bid, 0)

        if local_ch > 0:
            if local_ch >= api_ch:
                have_complete.append({**b, "local": local_ch})
            else:
                have_partial.append({**b, "local": local_ch, "gap": api_ch - local_ch})
        else:
            need_download.append(b)

    total_gap = sum(b["gap"] for b in have_partial) + sum(
        b["chapter_count"] for b in need_download
    )

    # Display audit summary
    table = Table(title="Catalog Audit", show_header=False, border_style="blue")
    table.add_column("Label", style="dim", width=22)
    table.add_column("Value", justify="right", width=10)
    table.add_row("Total in catalog", str(len(catalog)))
    table.add_row("  Downloadable", str(len(downloadable)))
    table.add_row("  No chapters/API", str(len(not_downloadable)))
    table.add_row("On disk (complete)", f"[green]{len(have_complete)}[/green]")
    table.add_row("On disk (partial)", f"[yellow]{len(have_partial)}[/yellow]")
    table.add_row("Not downloaded", f"[red]{len(need_download)}[/red]")
    table.add_row("Chapters to fetch", f"[bold]{total_gap:,}[/bold]")
    console.print(table)

    # Show top needs
    if need_download:
        nd = sorted(need_download, key=lambda x: -x.get("chapter_count", 0))
        console.print("\n[bold]Top 15 books to download:[/bold]")
        for b in nd[:15]:
            console.print(f"  {b['id']:>7} ch={b['chapter_count']:>5} {b['name'][:50]}")

    if have_partial:
        sorted_partial = sorted(have_partial, key=lambda x: -x["gap"])
        console.print("\n[bold]Partial downloads (top 15 by gap):[/bold]")
        for b in sorted_partial[:15]:
            console.print(
                f"  {b['id']:>7} {b['local']:>5}/{b['chapter_count']:<5} "
                f"gap={b['gap']:>5} {b['name'][:42]}"
            )

    if dry_run:
        console.print("\n[yellow]Dry run — plan file not written.[/yellow]")
        return []

    # Write the plan file (flat array for book-ingest compatibility)
    plan_entries: list[dict] = list(need_download)
    for b in sorted(have_partial, key=lambda x: -x["gap"]):
        entry = {k: v for k, v in b.items() if k not in ("local", "gap")}
        plan_entries.append(entry)

    PLAN_DIR.mkdir(parents=True, exist_ok=True)
    with open(PLAN_FILE, "w", encoding="utf-8") as f:
        json.dump(plan_entries, f, indent=2, ensure_ascii=False)
    console.print(
        f"\n[green]Plan written:[/green] {PLAN_FILE}\n"
        f"  {len(plan_entries)} entries "
        f"({len(need_download)} new + {len(have_partial)} partial)"
    )

    # Save audit result
    audit = {
        "summary": {
            "total_catalog": len(catalog),
            "downloadable": len(downloadable),
            "no_api_chapters": len(not_downloadable),
            "already_complete": len(have_complete),
            "partial": len(have_partial),
            "need_download": len(need_download),
            "chapters_to_fetch": total_gap,
        },
        "need_download": need_download,
        "partial": [
            {
                "id": b["id"],
                "name": b["name"],
                "chapter_count": b["chapter_count"],
                "first_chapter": b["first_chapter"],
                "local": b["local"],
                "gap": b["gap"],
            }
            for b in sorted(have_partial, key=lambda x: -x["gap"])
        ],
    }
    with open(AUDIT_FILE, "w", encoding="utf-8") as f:
        json.dump(audit, f, indent=2, ensure_ascii=False)
    console.print(f"  Audit saved: {AUDIT_FILE}")

    return plan_entries


# ── Mode: refresh (per-book metadata enrichment) ───────────────────────────


async def _run_refresh(
    entries: list[dict],
    workers: int,
    delay: float,
    scan: bool,
    min_chapters: int,
    fix_author: bool,
) -> tuple[list[dict], RefreshStats]:
    """Async core: refresh existing entries + optional scan."""
    stats = RefreshStats(total=len(entries))
    old_by_id = {e["id"]: e for e in entries}

    # Phase 1: refresh existing entries
    console.print("\n[bold blue]Phase 1:[/bold blue] Refreshing existing entries...")
    results = await _fetch_batch(
        list(old_by_id.keys()), workers, delay, "refresh", fix_author=fix_author
    )

    # Reconcile
    updated_list: list[dict] = []
    for book_id, old_entry in old_by_id.items():
        new = results.get(book_id)
        if new is None:
            stats.removed += 1
            continue

        old_ch = old_entry.get("chapter_count", 0)
        new_ch = new.get("chapter_count", 0)
        delta = max(0, new_ch - old_ch)

        if delta > 0 or new.get("name") != old_entry.get("name"):
            stats.updated += 1
            stats.new_chapters += delta
        else:
            stats.unchanged += 1

        if new.get("first_chapter") and new.get("chapter_count", 0) >= min_chapters:
            updated_list.append(new)

    # Phase 2 (optional): scan for missing books
    if scan:
        console.print("\n[bold blue]Phase 2:[/bold blue] Scanning for missing books...")
        upper = await find_upper_bound(workers, delay)
        console.print(f"  Detected upper bound: {upper}")
        known = set(old_by_id.keys())
        discovered = await scan_missing_ids(
            known, workers, delay, upper, fix_author=fix_author
        )
        discovered = [
            b for b in discovered if b.get("chapter_count", 0) >= min_chapters
        ]
        stats.discovered = len(discovered)
        updated_list.extend(discovered)
        console.print(
            f"  Discovered {len(discovered):,} new books (>= {min_chapters} chapters)"
        )

    # Sort by chapter_count descending
    updated_list.sort(key=lambda b: -b.get("chapter_count", 0))

    return updated_list, stats


def run_refresh(
    workers: int,
    delay: float,
    scan: bool,
    min_chapters: int,
    fix_author: bool,
    dry_run: bool,
) -> list[dict]:
    """Read existing plan, enrich with full per-book metadata, write back."""

    if not PLAN_FILE.exists():
        console.print(
            f"[red]Error:[/red] Plan file not found: {PLAN_FILE}\n"
            "  Run without --refresh first to generate an initial plan."
        )
        sys.exit(1)

    with open(PLAN_FILE, encoding="utf-8") as f:
        entries = json.load(f)

    if not isinstance(entries, list):
        console.print("[red]Error:[/red] Plan file must be a JSON array.")
        sys.exit(1)

    console.print(f"  Plan file:      [dim]{PLAN_FILE}[/dim]")
    console.print(f"  Input books:    [bold]{len(entries):,}[/bold]")
    console.print(f"  Workers:        [dim]{workers}[/dim]")
    console.print(f"  Min chapters:   [dim]{min_chapters}[/dim]")
    console.print(
        f"  Scan:           [dim]{'YES — full ID range' if scan else 'no'}[/dim]"
    )
    console.print(f"  Fix author:     [dim]{'YES' if fix_author else 'no'}[/dim]")

    start = time.time()
    updated, stats = asyncio.run(
        _run_refresh(entries, workers, delay, scan, min_chapters, fix_author)
    )
    elapsed = time.time() - start

    # Count author stats
    authors_generated = sum(1 for b in updated if b.get("author_generated"))
    no_author = sum(1 for b in updated if not b.get("author"))

    # Report
    console.print()
    table = Table(title="Refresh Report", show_header=False, border_style="green")
    table.add_column("Label", style="dim", width=22)
    table.add_column("Value", justify="right", width=12)
    table.add_row("Input books", f"{len(entries):,}")
    table.add_row("Output books", f"[bold]{len(updated):,}[/bold]")
    table.add_row("Updated", f"[green]{stats.updated:,}[/green]")
    table.add_row("Unchanged", f"{stats.unchanged:,}")
    table.add_row("Removed (404)", f"[red]{stats.removed:,}[/red]")
    table.add_row("Errors", f"{stats.errors:,}")
    if stats.discovered:
        table.add_row("Discovered (scan)", f"[cyan]{stats.discovered:,}[/cyan]")
    table.add_row("New chapters", f"[bold]{stats.new_chapters:,}[/bold]")
    table.add_row("Duration", f"{elapsed:.1f}s")
    if elapsed > 0:
        table.add_row("Rate", f"{len(entries) / elapsed:.0f} books/s")
    console.print(table)

    if authors_generated or no_author:
        console.print(f"\n  Authors generated from creator: {authors_generated:,}")
        console.print(f"  Books still without author: {no_author:,}")

    if dry_run:
        console.print("\n[yellow]Dry run — plan file not written.[/yellow]")
        return updated

    # Write output
    PLAN_DIR.mkdir(parents=True, exist_ok=True)
    with open(PLAN_FILE, "w", encoding="utf-8") as f:
        json.dump(updated, f, indent=2, ensure_ascii=False)
    console.print(f"\n[green]Wrote {len(updated):,} books to {PLAN_FILE}[/green]")

    # Show top books with most new chapters
    old_by_id = {e["id"]: e for e in entries}
    if stats.new_chapters > 0:
        gains = []
        for b in updated:
            old = old_by_id.get(b["id"])
            if old:
                delta = b["chapter_count"] - old.get("chapter_count", 0)
                if delta > 0:
                    gains.append((delta, b))
        gains.sort(key=lambda x: -x[0])
        if gains:
            console.print("\n[bold]Top books with new chapters:[/bold]")
            for delta, b in gains[:15]:
                console.print(f"  +{delta:>5} ch  {b['id']:>7}  {b['name'][:50]}")

    # Show discovered books
    if stats.discovered > 0:
        new_books = [b for b in updated if b["id"] not in old_by_id]
        new_books.sort(key=lambda b: -b.get("chapter_count", 0))
        console.print("\n[bold]Top discovered books (not in previous plan):[/bold]")
        for b in new_books[:20]:
            console.print(
                f"  {b['id']:>7}  ch={b['chapter_count']:>5}  {b['name'][:50]}"
            )
        if len(new_books) > 20:
            console.print(f"  [dim]... and {len(new_books) - 20:,} more[/dim]")

    return updated


# ── TTV plan generation ─────────────────────────────────────────────────────


def run_generate_ttv(
    max_pages: int = 0,
    min_chapters: int = MIN_CHAPTER_COUNT,
    dry_run: bool = False,
) -> list[dict]:
    """Scrape TTV listing pages, cross-ref with bundles, write plan.

    This is the TTV equivalent of :func:`run_generate`.  It scrapes the
    ``/tong-hop`` filter pages on truyen.tangthuvien.vn, assigns 10M+
    offset IDs, and writes a plan file at ``data/books_plan_ttv.json``.
    """
    from src.sources.ttv import (
        TTV_BASE_URL,
        TTV_HEADERS,
        build_mtc_index,
        get_or_create_book_id,
        is_mtc_duplicate,
        load_registry,
        parse_listing_page,
        parse_listing_total_pages,
        save_registry,
    )

    console.print("\n[bold blue]Scraping TTV catalog...[/bold blue]")

    registry = load_registry()
    mtc_index = build_mtc_index()
    console.print(f"  MTC index: {len(mtc_index)} books for dedup")
    console.print(f"  TTV registry: {len(registry)} existing IDs")

    all_books: list[dict] = []
    seen_slugs: set[str] = set()
    skipped_mtc = 0

    with httpx.Client(headers=TTV_HEADERS, timeout=30, follow_redirects=True) as client:
        page = 0
        # 0 = scrape all available pages; positive = cap at that number
        page_limit = max_pages if max_pages > 0 else 10_000

        while page < page_limit:
            page += 1
            try:
                r = client.get(
                    f"{TTV_BASE_URL}/tong-hop",
                    params={"tp": "cv", "ctg": "0", "page": str(page)},
                )
                html = r.text
            except Exception as e:
                console.print(f"  Page {page}: FAILED ({e})")
                break

            books = parse_listing_page(html)
            if not books:
                console.print(f"  Page {page}: no books found, stopping")
                break

            if page == 1:
                total_pages = parse_listing_total_pages(html)
                page_limit = min(page_limit, total_pages)
                console.print(
                    f"  Total pages available: {total_pages}, will scrape: {page_limit}"
                )

            new_on_page = 0
            for book in books:
                ttv_slug = book.get("ttv_slug", book["slug"])
                if not ttv_slug or ttv_slug in seen_slugs:
                    continue
                seen_slugs.add(ttv_slug)

                # Dedup against MTC using the ASCII-clean slug
                if is_mtc_duplicate(book["slug"], mtc_index):
                    skipped_mtc += 1
                    continue

                all_books.append(book)
                new_on_page += 1

            if page % 50 == 0 or page == 1:
                console.print(
                    f"  Page {page}/{page_limit}: {len(books)} found, "
                    f"{new_on_page} new, total: {len(all_books)}"
                )

            time.sleep(REQUEST_DELAY)

    console.print(
        f"\n  Discovery complete: {len(all_books)} unique books, "
        f"{skipped_mtc} MTC duplicates skipped"
    )

    # Assign IDs and build plan entries
    console.print("[bold blue]Building plan entries...[/bold blue]")
    known_bids = get_bundle_chapter_counts()

    have_complete: list[dict] = []
    have_partial: list[dict] = []
    need_download: list[dict] = []

    for book in all_books:
        # Use ttv_slug (original TTV URL slug) as the registry key
        # for backward compatibility with existing ID assignments.
        ttv_slug = book.get("ttv_slug", book["slug"])
        slug = book["slug"]  # ASCII-clean for DB/website
        book_id = get_or_create_book_id(ttv_slug, registry)
        ch_count = book.get("chapter_count", 0)

        if ch_count < min_chapters:
            continue

        entry = {
            "id": book_id,
            "name": book["name"],
            "slug": slug,
            "ttv_slug": ttv_slug,
            "chapter_count": ch_count,
            "status": _map_ttv_status(book.get("status_text", "")),
            "status_name": book.get("status_text", ""),
            "source": "ttv",
            "author": {
                "id": book.get("author_id"),
                "name": book.get("author_name", ""),
            },
            "genres": [{"name": book.get("genre", ""), "slug": ""}]
            if book.get("genre")
            else [],
            "tags": [],
            "synopsis": book.get("synopsis", ""),
            "cover_url": book.get("cover_url", ""),
            "word_count": 0,
            "view_count": 0,
            "bookmark_count": 0,
            "vote_count": 0,
            "comment_count": 0,
            "review_score": 0,
            "review_count": 0,
            "created_at": None,
            "updated_at": book.get("updated_at"),
            "published_at": None,
            "new_chap_at": None,
        }

        local_ch = known_bids.get(book_id, 0)
        if local_ch > 0:
            if local_ch >= ch_count:
                have_complete.append({**entry, "local": local_ch})
            else:
                have_partial.append(
                    {**entry, "local": local_ch, "gap": ch_count - local_ch}
                )
        else:
            need_download.append(entry)

    # Save registry (new IDs may have been created)
    save_registry(registry)

    # Display audit summary
    total_gap = sum(b.get("gap", 0) for b in have_partial) + sum(
        b["chapter_count"] for b in need_download
    )

    table = Table(title="TTV Catalog Audit", show_header=False, border_style="cyan")
    table.add_column("Label", style="dim", width=22)
    table.add_column("Value", justify="right", width=10)
    table.add_row("Discovered books", str(len(all_books)))
    table.add_row(
        f"  >= {min_chapters} chapters",
        str(len(need_download) + len(have_partial) + len(have_complete)),
    )
    table.add_row("On disk (complete)", f"[green]{len(have_complete)}[/green]")
    table.add_row("On disk (partial)", f"[yellow]{len(have_partial)}[/yellow]")
    table.add_row("Not downloaded", f"[red]{len(need_download)}[/red]")
    table.add_row("Chapters to fetch", f"[bold]{total_gap:,}[/bold]")
    table.add_row("MTC dupes skipped", str(skipped_mtc))
    console.print(table)

    if dry_run:
        console.print("\n[yellow]Dry run — plan file not written.[/yellow]")
        return []

    # Write plan file
    plan_entries: list[dict] = list(need_download)
    for b in sorted(have_partial, key=lambda x: -x.get("gap", 0)):
        entry = {k: v for k, v in b.items() if k not in ("local", "gap")}
        plan_entries.append(entry)

    PLAN_DIR.mkdir(parents=True, exist_ok=True)
    with open(TTV_PLAN_FILE, "w", encoding="utf-8") as f:
        json.dump(plan_entries, f, indent=2, ensure_ascii=False)
    console.print(
        f"\n[green]Plan written:[/green] {TTV_PLAN_FILE}\n"
        f"  {len(plan_entries)} entries "
        f"({len(need_download)} new + {len(have_partial)} partial)"
    )

    return plan_entries


def _map_ttv_status(text: str) -> int:
    """Map Vietnamese status text to numeric code (1=ongoing, 2=done, 3=paused)."""
    t = text.lower().strip()
    if "hoàn thành" in t or "hoan thanh" in t:
        return 2
    if "tạm dừng" in t or "tam dung" in t:
        return 3
    return 1


async def _run_refresh_ttv(
    entries: list[dict],
    workers: int,
    delay: float,
    min_chapters: int,
) -> tuple[list[dict], RefreshStats]:
    """Async core: re-fetch metadata for TTV books via HTML scraping."""
    from src.sources.ttv import (
        TTV_BASE_URL,
        TTV_HEADERS,
        parse_book_detail,
    )

    stats = RefreshStats(total=len(entries))
    old_by_id = {e["id"]: e for e in entries}

    sem = asyncio.Semaphore(workers)
    results: dict[int, dict | None] = {}
    results_lock = asyncio.Lock()
    progress_count = {"done": 0}
    total = len(entries)
    start = time.time()

    async with httpx.AsyncClient(
        headers=TTV_HEADERS,
        timeout=httpx.Timeout(connect=10, read=30, write=10, pool=30),
        follow_redirects=True,
        limits=httpx.Limits(
            max_connections=workers + 10,
            max_keepalive_connections=workers,
        ),
    ) as client:

        async def _fetch_one(entry: dict) -> None:
            book_id = entry["id"]
            slug = entry.get("slug", "")
            if not slug:
                async with results_lock:
                    results[book_id] = None
                    progress_count["done"] += 1
                return

            for attempt in range(3):
                async with sem:
                    await asyncio.sleep(delay)
                    try:
                        r = await client.get(f"{TTV_BASE_URL}/doc-truyen/{slug}")
                    except httpx.TransportError:
                        if attempt < 2:
                            await asyncio.sleep(2 ** (attempt + 1))
                            continue
                        async with results_lock:
                            results[book_id] = None
                            progress_count["done"] += 1
                        return

                if r.status_code == 404:
                    async with results_lock:
                        results[book_id] = None
                        progress_count["done"] += 1
                    return

                if r.status_code != 200:
                    if attempt < 2:
                        await asyncio.sleep(2 ** (attempt + 1))
                        continue
                    async with results_lock:
                        results[book_id] = None
                        progress_count["done"] += 1
                    return

                meta = parse_book_detail(r.text, slug)
                meta["id"] = book_id
                # Carry over fields not in the HTML
                meta["source"] = "ttv"

                async with results_lock:
                    results[book_id] = meta
                    progress_count["done"] += 1

                done = progress_count["done"]
                if done % 200 == 0 or done == total:
                    elapsed = time.time() - start
                    rate = done / elapsed if elapsed > 0 else 0
                    console.print(f"  refresh [{done:,}/{total:,}] {rate:.0f}/s")
                return

            # exhausted retries
            async with results_lock:
                results[book_id] = None
                progress_count["done"] += 1

        tasks = [_fetch_one(e) for e in entries]
        await asyncio.gather(*tasks)

    # Reconcile
    updated_list: list[dict] = []
    for book_id, old_entry in old_by_id.items():
        new = results.get(book_id)
        if new is None:
            stats.removed += 1
            continue

        old_ch = old_entry.get("chapter_count", 0)
        new_ch = new.get("chapter_count", 0)
        delta = max(0, new_ch - old_ch)

        if delta > 0 or new.get("name") != old_entry.get("name"):
            stats.updated += 1
            stats.new_chapters += delta
        else:
            stats.unchanged += 1

        if new.get("chapter_count", 0) >= min_chapters:
            updated_list.append(new)

    updated_list.sort(key=lambda b: -b.get("chapter_count", 0))
    return updated_list, stats


def run_refresh_ttv(
    workers: int,
    delay: float,
    min_chapters: int,
    dry_run: bool,
) -> list[dict]:
    """Read existing TTV plan, re-fetch metadata from HTML, write back."""

    if not TTV_PLAN_FILE.exists():
        console.print(
            f"[red]Error:[/red] TTV plan file not found: {TTV_PLAN_FILE}\n"
            "  Run with --source ttv (no --refresh) first to generate an initial plan."
        )
        sys.exit(1)

    with open(TTV_PLAN_FILE, encoding="utf-8") as f:
        entries = json.load(f)

    if not isinstance(entries, list):
        console.print("[red]Error:[/red] TTV plan file must be a JSON array.")
        sys.exit(1)

    console.print(f"  Plan file:      [dim]{TTV_PLAN_FILE}[/dim]")
    console.print(f"  Input books:    [bold]{len(entries):,}[/bold]")
    console.print(f"  Workers:        [dim]{workers}[/dim]")
    console.print(f"  Min chapters:   [dim]{min_chapters}[/dim]")

    start = time.time()
    updated, stats = asyncio.run(
        _run_refresh_ttv(entries, workers, delay, min_chapters)
    )
    elapsed = time.time() - start

    # Report
    console.print()
    table = Table(title="TTV Refresh Report", show_header=False, border_style="cyan")
    table.add_column("Label", style="dim", width=22)
    table.add_column("Value", justify="right", width=12)
    table.add_row("Input books", f"{len(entries):,}")
    table.add_row("Output books", f"[bold]{len(updated):,}[/bold]")
    table.add_row("Updated", f"[green]{stats.updated:,}[/green]")
    table.add_row("Unchanged", f"{stats.unchanged:,}")
    table.add_row("Removed (404)", f"[red]{stats.removed:,}[/red]")
    table.add_row("New chapters", f"[bold]{stats.new_chapters:,}[/bold]")
    table.add_row("Duration", f"{elapsed:.1f}s")
    if elapsed > 0:
        table.add_row("Rate", f"{len(entries) / elapsed:.0f} books/s")
    console.print(table)

    if dry_run:
        console.print("\n[yellow]Dry run — plan file not written.[/yellow]")
        return updated

    PLAN_DIR.mkdir(parents=True, exist_ok=True)
    with open(TTV_PLAN_FILE, "w", encoding="utf-8") as f:
        json.dump(updated, f, indent=2, ensure_ascii=False)
    console.print(f"\n[green]Wrote {len(updated):,} books to {TTV_PLAN_FILE}[/green]")

    return updated


def run_cover_pull_ttv(
    plan_entries: list[dict],
    force: bool,
    dry_run: bool,
    delay: float,
) -> None:
    """Download missing covers for TTV books using cover_url from the plan."""
    from src.sources.ttv import TTV_HEADERS

    COVERS_DIR.mkdir(parents=True, exist_ok=True)

    if force:
        pending = plan_entries
    else:
        pending = [
            e
            for e in plan_entries
            if not (COVERS_DIR / f"{e['id']}.jpg").exists()
            and e.get("cover_url")
            and "default-book" not in e.get("cover_url", "")
        ]

    console.print(f"  Plan entries:   [bold]{len(plan_entries)}[/bold]")
    console.print(f"  Missing covers: [bold]{len(pending)}[/bold]")
    console.print(f"  Destination:    [dim]{COVERS_DIR}[/dim]")
    console.print()

    if not pending:
        console.print("[green]All TTV covers present. Nothing to do.[/green]")
        return

    if dry_run:
        console.print("[yellow]Dry run — would download covers for:[/yellow]")
        for e in pending[:30]:
            console.print(f"  {e['id']}  {e.get('name', '?')[:40]}")
        if len(pending) > 30:
            console.print(f"  [dim]... and {len(pending) - 30} more[/dim]")
        return

    succeeded = 0
    failed = 0

    progress = Progress(
        TextColumn("[bold cyan]{task.description}"),
        BarColumn(bar_width=30),
        MofNCompleteColumn(),
        TextColumn("•"),
        TimeElapsedColumn(),
        TextColumn("•"),
        TimeRemainingColumn(),
    )

    with (
        progress,
        httpx.Client(headers=TTV_HEADERS, timeout=30, follow_redirects=True) as client,
    ):
        task = progress.add_task("Pulling TTV covers", total=len(pending))

        for i, entry in enumerate(pending, 1):
            bid = entry["id"]
            cover_url = entry.get("cover_url", "")
            dest = str(COVERS_DIR / f"{bid}.jpg")

            progress.update(task, description=f"Cover {bid}")

            try:
                r = client.get(cover_url, follow_redirects=True, timeout=30)
                if r.status_code == 200 and len(r.content) > 100:
                    with open(dest, "wb") as f:
                        f.write(r.content)
                    succeeded += 1
                else:
                    failed += 1
            except Exception:
                failed += 1

            progress.advance(task)
            if i < len(pending):
                time.sleep(delay)

    console.print(
        f"\nDone: [green]{succeeded}[/green] succeeded, "
        f"[red]{failed}[/red] failed out of {len(pending)}"
    )


# ── TF plan generation ──────────────────────────────────────────────────────


def run_generate_tf(
    max_pages: int = 0,
    min_chapters: int = MIN_CHAPTER_COUNT,
    dry_run: bool = False,
) -> list[dict]:
    """Scrape TF hot completed listing, cross-ref with bundles, write plan.

    Scrapes ``/danh-sach/truyen-hot/trang-{N}/`` for all completed hot books,
    deduplicates against existing books in the DB (all sources), filters by
    min chapter count, and writes ``data/books_plan_tf.json``.
    """
    from src.sources.tf import (
        TF_BASE_URL,
        TF_HEADERS,
        build_existing_index,
        get_or_create_book_id,
        is_duplicate,
        load_registry,
        parse_listing_last_page,
        parse_listing_page,
        save_registry,
    )

    console.print("\n[bold blue]Scraping TF hot completed listing...[/bold blue]")

    registry = load_registry()
    existing_index = build_existing_index()
    console.print(f"  Existing books index: {len(existing_index)} books for dedup")
    console.print(f"  TF registry: {len(registry)} existing IDs")

    all_books: list[dict] = []
    seen_slugs: set[str] = set()
    skipped_dup = 0

    with httpx.Client(headers=TF_HEADERS, timeout=30, follow_redirects=True) as client:
        page = 0
        page_limit = max_pages if max_pages > 0 else 100_000

        while page < page_limit:
            page += 1
            url = f"{TF_BASE_URL}/danh-sach/truyen-hot/trang-{page}/"

            try:
                r = client.get(url)
                html = r.text
            except Exception as e:
                console.print(f"  Page {page}: FAILED ({e})")
                break

            books = parse_listing_page(html)
            if not books:
                console.print(f"  Page {page}: no books found, stopping")
                break

            if page == 1:
                total_pages = parse_listing_last_page(html)
                page_limit = min(page_limit, total_pages)
                console.print(
                    f"  Total pages available: {total_pages}, will scrape: {page_limit}"
                )

            new_on_page = 0
            for book in books:
                tf_slug = book.get("tf_slug", book["slug"])
                if not tf_slug or tf_slug in seen_slugs:
                    continue
                seen_slugs.add(tf_slug)

                # Dedup against existing books (all sources)
                if is_duplicate(book["slug"], book["name"], existing_index):
                    skipped_dup += 1
                    continue

                all_books.append(book)
                new_on_page += 1

            if page % 50 == 0 or page == 1:
                console.print(
                    f"  Page {page}/{page_limit}: {len(books)} found, "
                    f"{new_on_page} new, total: {len(all_books)}"
                )

            time.sleep(REQUEST_DELAY)

    console.print(
        f"\n  Discovery complete: {len(all_books)} unique books, "
        f"{skipped_dup} duplicates skipped"
    )

    # Assign IDs and build plan entries
    console.print("[bold blue]Building plan entries...[/bold blue]")
    known_bids = get_bundle_chapter_counts()

    have_complete: list[dict] = []
    have_partial: list[dict] = []
    need_download: list[dict] = []

    for book in all_books:
        tf_slug = book.get("tf_slug", book["slug"])
        slug = book["slug"]
        book_id = get_or_create_book_id(tf_slug, registry)
        ch_count = book.get("chapter_count", 0)

        if ch_count < min_chapters:
            continue

        from src.sources.tf import AUTHOR_ID_OFFSET as TF_AUTHOR_OFFSET

        # Generate deterministic author ID
        author_name = book.get("author_name", "")
        author_id = None
        if author_name:
            author_id = TF_AUTHOR_OFFSET + (hash(author_name) % 10_000_000)
            if author_id < TF_AUTHOR_OFFSET:
                author_id += 10_000_000

        entry = {
            "id": book_id,
            "name": book["name"],
            "slug": slug,
            "tf_slug": tf_slug,
            "chapter_count": ch_count,
            "status": 2,
            "status_name": "Full",
            "source": "tf",
            "author": {
                "id": author_id,
                "name": author_name,
            },
            "genres": [],
            "tags": [],
            "synopsis": "",
            "cover_url": book.get("cover_url", ""),
            "word_count": 0,
            "view_count": 0,
            "bookmark_count": 0,
            "vote_count": 0,
            "comment_count": 0,
            "review_score": 0,
            "review_count": 0,
            "created_at": None,
            "updated_at": None,
            "published_at": None,
            "new_chap_at": None,
        }

        local_ch = known_bids.get(book_id, 0)
        if local_ch > 0:
            if local_ch >= ch_count:
                have_complete.append({**entry, "local": local_ch})
            else:
                have_partial.append(
                    {**entry, "local": local_ch, "gap": ch_count - local_ch}
                )
        else:
            need_download.append(entry)

    # Save registry
    save_registry(registry)

    # Display audit summary
    total_gap = sum(b.get("gap", 0) for b in have_partial) + sum(
        b["chapter_count"] for b in need_download
    )

    table = Table(title="TF Catalog Audit", show_header=False, border_style="yellow")
    table.add_column("Label", style="dim", width=22)
    table.add_column("Value", justify="right", width=10)
    table.add_row("Discovered books", str(len(all_books)))
    table.add_row(
        f"  >= {min_chapters} chapters",
        str(len(need_download) + len(have_partial) + len(have_complete)),
    )
    table.add_row("On disk (complete)", f"[green]{len(have_complete)}[/green]")
    table.add_row("On disk (partial)", f"[yellow]{len(have_partial)}[/yellow]")
    table.add_row("Not downloaded", f"[red]{len(need_download)}[/red]")
    table.add_row("Chapters to fetch", f"[bold]{total_gap:,}[/bold]")
    table.add_row("Duplicates skipped", str(skipped_dup))
    console.print(table)

    if dry_run:
        console.print("\n[yellow]Dry run — plan file not written.[/yellow]")
        return []

    # Write plan file
    plan_entries: list[dict] = list(need_download)
    for b in sorted(have_partial, key=lambda x: -x.get("gap", 0)):
        entry = {k: v for k, v in b.items() if k not in ("local", "gap")}
        plan_entries.append(entry)

    PLAN_DIR.mkdir(parents=True, exist_ok=True)
    with open(TF_PLAN_FILE, "w", encoding="utf-8") as f:
        json.dump(plan_entries, f, indent=2, ensure_ascii=False)
    console.print(
        f"\n[green]Plan written:[/green] {TF_PLAN_FILE}\n"
        f"  {len(plan_entries)} entries "
        f"({len(need_download)} new + {len(have_partial)} partial)"
    )

    return plan_entries


async def _run_refresh_tf(
    entries: list[dict],
    workers: int,
    delay: float,
    min_chapters: int,
) -> tuple[list[dict], RefreshStats]:
    """Async core: re-fetch metadata for TF books via HTML scraping."""
    from src.sources.tf import (
        TF_BASE_URL,
        TF_HEADERS,
        parse_book_detail,
    )

    stats = RefreshStats(total=len(entries))
    old_by_id = {e["id"]: e for e in entries}

    sem = asyncio.Semaphore(workers)
    results: dict[int, dict | None] = {}
    results_lock = asyncio.Lock()
    progress_count = {"done": 0}
    total = len(entries)
    start = time.time()

    async with httpx.AsyncClient(
        headers=TF_HEADERS,
        timeout=httpx.Timeout(connect=10, read=30, write=10, pool=30),
        follow_redirects=True,
        limits=httpx.Limits(
            max_connections=workers + 10,
            max_keepalive_connections=workers,
        ),
    ) as client:

        async def _fetch_one(entry: dict) -> None:
            book_id = entry["id"]
            tf_slug = entry.get("tf_slug") or entry.get("slug", "")
            if not tf_slug:
                async with results_lock:
                    results[book_id] = None
                    progress_count["done"] += 1
                return

            for attempt in range(3):
                async with sem:
                    await asyncio.sleep(delay)
                    try:
                        r = await client.get(f"{TF_BASE_URL}/{tf_slug}/")
                    except httpx.TransportError:
                        if attempt < 2:
                            await asyncio.sleep(2 ** (attempt + 1))
                            continue
                        async with results_lock:
                            results[book_id] = None
                            progress_count["done"] += 1
                        return

                if r.status_code == 404:
                    async with results_lock:
                        results[book_id] = None
                        progress_count["done"] += 1
                    return

                if r.status_code != 200:
                    if attempt < 2:
                        await asyncio.sleep(2 ** (attempt + 1))
                        continue
                    async with results_lock:
                        results[book_id] = None
                        progress_count["done"] += 1
                    return

                meta = parse_book_detail(r.text, tf_slug)
                meta["id"] = book_id
                meta["source"] = "tf"

                async with results_lock:
                    results[book_id] = meta
                    progress_count["done"] += 1

                done = progress_count["done"]
                if done % 200 == 0 or done == total:
                    elapsed = time.time() - start
                    rate = done / elapsed if elapsed > 0 else 0
                    console.print(f"  refresh [{done:,}/{total:,}] {rate:.0f}/s")
                return

            # exhausted retries
            async with results_lock:
                results[book_id] = None
                progress_count["done"] += 1

        tasks = [_fetch_one(e) for e in entries]
        await asyncio.gather(*tasks)

    # Reconcile
    updated_list: list[dict] = []
    for book_id, old_entry in old_by_id.items():
        new = results.get(book_id)
        if new is None:
            stats.removed += 1
            continue

        old_ch = old_entry.get("chapter_count", 0)
        new_ch = new.get("chapter_count", 0)
        delta = max(0, new_ch - old_ch)

        if delta > 0 or new.get("name") != old_entry.get("name"):
            stats.updated += 1
            stats.new_chapters += delta
        else:
            stats.unchanged += 1

        if new.get("chapter_count", 0) >= min_chapters:
            updated_list.append(new)

    updated_list.sort(key=lambda b: -b.get("chapter_count", 0))
    return updated_list, stats


def run_refresh_tf(
    workers: int,
    delay: float,
    min_chapters: int,
    dry_run: bool,
) -> list[dict]:
    """Read existing TF plan, re-fetch metadata from HTML, write back."""

    if not TF_PLAN_FILE.exists():
        console.print(
            f"[red]Error:[/red] TF plan file not found: {TF_PLAN_FILE}\n"
            "  Run with --source tf (no --refresh) first to generate an initial plan."
        )
        sys.exit(1)

    with open(TF_PLAN_FILE, encoding="utf-8") as f:
        entries = json.load(f)

    if not isinstance(entries, list):
        console.print("[red]Error:[/red] TF plan file must be a JSON array.")
        sys.exit(1)

    console.print(f"  Plan file:      [dim]{TF_PLAN_FILE}[/dim]")
    console.print(f"  Input books:    [bold]{len(entries):,}[/bold]")
    console.print(f"  Workers:        [dim]{workers}[/dim]")
    console.print(f"  Min chapters:   [dim]{min_chapters}[/dim]")

    start = time.time()
    updated, stats = asyncio.run(_run_refresh_tf(entries, workers, delay, min_chapters))
    elapsed = time.time() - start

    # Report
    console.print()
    table = Table(title="TF Refresh Report", show_header=False, border_style="yellow")
    table.add_column("Label", style="dim", width=22)
    table.add_column("Value", justify="right", width=12)
    table.add_row("Input books", f"{len(entries):,}")
    table.add_row("Output books", f"[bold]{len(updated):,}[/bold]")
    table.add_row("Updated", f"[green]{stats.updated:,}[/green]")
    table.add_row("Unchanged", f"{stats.unchanged:,}")
    table.add_row("Removed (404)", f"[red]{stats.removed:,}[/red]")
    table.add_row("New chapters", f"[bold]{stats.new_chapters:,}[/bold]")
    table.add_row("Duration", f"{elapsed:.1f}s")
    if elapsed > 0:
        table.add_row("Rate", f"{len(entries) / elapsed:.0f} books/s")
    console.print(table)

    if dry_run:
        console.print("\n[yellow]Dry run — plan file not written.[/yellow]")
        return updated

    PLAN_DIR.mkdir(parents=True, exist_ok=True)
    with open(TF_PLAN_FILE, "w", encoding="utf-8") as f:
        json.dump(updated, f, indent=2, ensure_ascii=False)
    console.print(f"\n[green]Wrote {len(updated):,} books to {TF_PLAN_FILE}[/green]")

    return updated


def run_cover_pull_tf(
    plan_entries: list[dict],
    force: bool,
    dry_run: bool,
    delay: float,
) -> None:
    """Download missing covers for TF books using cover_url from the plan."""
    from src.sources.tf import TF_HEADERS as _TF_HEADERS

    COVERS_DIR.mkdir(parents=True, exist_ok=True)

    if force:
        pending = plan_entries
    else:
        pending = [
            e
            for e in plan_entries
            if not (COVERS_DIR / f"{e['id']}.jpg").exists() and e.get("cover_url")
        ]

    console.print(f"  Plan entries:   [bold]{len(plan_entries)}[/bold]")
    console.print(f"  Missing covers: [bold]{len(pending)}[/bold]")
    console.print(f"  Destination:    [dim]{COVERS_DIR}[/dim]")
    console.print()

    if not pending:
        console.print("[green]All TF covers present. Nothing to do.[/green]")
        return

    if dry_run:
        console.print("[yellow]Dry run — would download covers for:[/yellow]")
        for e in pending[:30]:
            console.print(f"  {e['id']}  {e.get('name', '?')[:40]}")
        if len(pending) > 30:
            console.print(f"  [dim]... and {len(pending) - 30} more[/dim]")
        return

    succeeded = 0
    failed = 0

    progress = Progress(
        TextColumn("[bold yellow]{task.description}"),
        BarColumn(bar_width=30),
        MofNCompleteColumn(),
        TextColumn("•"),
        TimeElapsedColumn(),
        TextColumn("•"),
        TimeRemainingColumn(),
    )

    with (
        progress,
        httpx.Client(headers=_TF_HEADERS, timeout=30, follow_redirects=True) as client,
    ):
        task = progress.add_task("Pulling TF covers", total=len(pending))

        for i, entry in enumerate(pending, 1):
            bid = entry["id"]
            cover_url = entry.get("cover_url", "")
            dest = str(COVERS_DIR / f"{bid}.jpg")

            progress.update(task, description=f"Cover {bid}")

            try:
                r = client.get(cover_url, follow_redirects=True, timeout=30)
                if r.status_code == 200 and len(r.content) > 100:
                    with open(dest, "wb") as f:
                        f.write(r.content)
                    succeeded += 1
                else:
                    failed += 1
            except Exception:
                failed += 1

            progress.advance(task)
            if i < len(pending):
                time.sleep(delay)

    console.print(
        f"\nDone: [green]{succeeded}[/green] succeeded, "
        f"[red]{failed}[/red] failed out of {len(pending)}"
    )


# ── CLI ─────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Generate and maintain the book-ingest download plan.\n\n"
            "Default (no flags): paginate the source catalog, cross-ref with\n"
            "local bundles, write a fresh plan, and pull missing covers.\n\n"
            "--source: select data source (mtc, ttv, or tf; default: mtc).\n"
            "--refresh: read existing plan, enrich with full per-book metadata.\n"
            "--scan (with --refresh, MTC only): also probe the full MTC ID\n"
            "range to discover books invisible to the catalog endpoint."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    # Source selection
    parser.add_argument(
        "--source",
        choices=["mtc", "ttv", "tf"],
        default="mtc",
        help="Data source: mtc (metruyencv, default), ttv (tangthuvien), or tf (truyenfull)",
    )

    # Mode flags
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Enrich existing plan with full per-book metadata "
        "(author, genres, tags, synopsis, poster, stats)",
    )
    parser.add_argument(
        "--scan",
        action="store_true",
        help="(With --refresh, MTC only) Scan the full MTC ID range to "
        "discover books missing from the plan",
    )
    parser.add_argument(
        "--cover-only",
        action="store_true",
        help="Only download missing covers; skip plan generation",
    )

    # TTV discovery options
    parser.add_argument(
        "--pages",
        type=int,
        default=0,
        help="(TTV only) Number of listing pages to scrape (default: 0 = all, ~20 books/page)",
    )

    # Filtering
    parser.add_argument(
        "--fix-author",
        nargs="?",
        const=True,
        default=True,
        type=lambda v: v.lower() not in ("0", "false", "no", "off"),
        help="Generate synthetic authors from creators when author is "
        "missing or a placeholder name (default: on). "
        "Use --fix-author 0 or --no-fix-author to disable.",
    )
    parser.add_argument(
        "--no-fix-author",
        dest="fix_author",
        action="store_false",
        help="Disable synthetic author generation.",
    )
    parser.add_argument(
        "--min-chapters",
        type=int,
        default=MIN_CHAPTER_COUNT,
        help=f"Exclude books with fewer chapters (default: {MIN_CHAPTER_COUNT})",
    )

    # Cover options
    parser.add_argument(
        "--ids",
        type=int,
        nargs="+",
        help="Specific book IDs for --cover-only (default: all bundles)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-download covers even if they already exist",
    )

    # Refresh options
    parser.add_argument(
        "--workers",
        type=int,
        default=150,
        help="Max concurrent requests for --refresh (default: 150)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=None,
        help="Delay between requests in seconds (default: 0.015 for MTC, 0.3 for TTV)",
    )

    # General
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview what would be done without writing any files",
    )

    args = parser.parse_args()

    is_ttv = args.source == "ttv"
    is_tf = args.source == "tf"

    # Resolve delay default per source
    if args.delay is None:
        args.delay = 0.3 if (is_ttv or is_tf) else 0.015

    # Validation
    if args.scan and not args.refresh:
        console.print(
            "[red]Error:[/red] --scan requires --refresh.\n"
            "  --scan probes every ID in the MTC range; it needs an existing\n"
            "  plan file as the starting point.  Run with --refresh --scan."
        )
        sys.exit(1)

    if args.scan and (is_ttv or is_tf):
        console.print(
            "[red]Error:[/red] --scan is only supported for MTC.\n"
            "  TTV/TF discovery uses listing-page scraping, not ID-range probing."
        )
        sys.exit(1)

    # Determine what to do
    do_plan = not args.cover_only
    do_covers = not args.refresh  # covers run unless --refresh (refresh is plan-only)

    if args.cover_only:
        do_plan = False
        do_covers = True

    # Title
    src_label = "TF" if is_tf else ("TTV" if is_ttv else "MTC")
    if args.cover_only:
        subtitle = f"{src_label} covers only"
    elif args.refresh and args.scan:
        subtitle = f"{src_label} refresh + scan"
    elif args.refresh:
        subtitle = f"{src_label} refresh"
    else:
        subtitle = f"{src_label} catalog → plan + covers"

    console.print(
        Panel(
            f"[bold]{src_label} Plan Generator[/bold]",
            subtitle=subtitle,
            border_style="yellow" if is_tf else ("cyan" if is_ttv else "blue"),
            expand=False,
        )
    )

    # ── Plan phase ──────────────────────────────────────────────────────

    if do_plan:
        if is_tf:
            if args.refresh:
                run_refresh_tf(
                    workers=min(args.workers, 30),
                    delay=args.delay,
                    min_chapters=args.min_chapters,
                    dry_run=args.dry_run,
                )
            else:
                run_generate_tf(
                    max_pages=args.pages,
                    min_chapters=args.min_chapters,
                    dry_run=args.dry_run,
                )
        elif is_ttv:
            if args.refresh:
                run_refresh_ttv(
                    workers=min(args.workers, 30),  # TTV needs fewer workers
                    delay=args.delay,
                    min_chapters=args.min_chapters,
                    dry_run=args.dry_run,
                )
            else:
                run_generate_ttv(
                    max_pages=args.pages,
                    min_chapters=args.min_chapters,
                    dry_run=args.dry_run,
                )
        else:
            if args.refresh:
                run_refresh(
                    workers=args.workers,
                    delay=args.delay,
                    scan=args.scan,
                    min_chapters=args.min_chapters,
                    fix_author=args.fix_author,
                    dry_run=args.dry_run,
                )
            else:
                run_generate(dry_run=args.dry_run)

    # ── Cover phase ─────────────────────────────────────────────────────

    if do_covers:
        if is_tf:
            plan_path = TF_PLAN_FILE
            if plan_path.exists():
                with open(plan_path, encoding="utf-8") as f:
                    tf_entries = json.load(f)
                console.print(f"\n[bold yellow]TF Cover Pull[/bold yellow]")
                run_cover_pull_tf(tf_entries, args.force, args.dry_run, args.delay)
            else:
                console.print(
                    f"\n[yellow]TF plan file not found: {plan_path}[/yellow]\n"
                    "  Run without --cover-only first to generate a plan."
                )
        elif is_ttv:
            # TTV covers come from the plan file (cover_url field)
            plan_path = TTV_PLAN_FILE
            if plan_path.exists():
                with open(plan_path, encoding="utf-8") as f:
                    ttv_entries = json.load(f)
                console.print(f"\n[bold cyan]TTV Cover Pull[/bold cyan]")
                run_cover_pull_ttv(ttv_entries, args.force, args.dry_run, args.delay)
            else:
                console.print(
                    f"\n[yellow]TTV plan file not found: {plan_path}[/yellow]\n"
                    "  Run without --cover-only first to generate a plan."
                )
        else:
            if args.ids:
                target_ids = sorted(args.ids)
            else:
                target_ids = get_bundle_book_ids()

            if not target_ids:
                console.print(
                    f"\n[yellow]No bundle files found in {COMPRESSED_DIR}[/yellow]"
                )
            else:
                console.print(f"\n[bold blue]Cover Pull[/bold blue]")
                console.print(
                    f"  Source:         [dim]bundles in {COMPRESSED_DIR}[/dim]"
                )
                console.print(f"  Books found:    [bold]{len(target_ids)}[/bold]")
                run_cover_pull(target_ids, args.force, args.dry_run, args.delay)


if __name__ == "__main__":
    main()
