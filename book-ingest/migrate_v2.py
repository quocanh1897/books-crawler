#!/usr/bin/env python3
"""migrate_v2.py — Convert BLIB v1 bundles to v2 format.

Reads existing v1 bundles and rewrites them as v2 with per-chapter
inline metadata (title, slug, word_count, chapter_id).

Modes:
  Default (local only):
    Metadata sourced from SQLite chapters table.  chapter_id = 0 for
    all chapters (unknown without API).

  --refetch:
    Also calls the MTC API to populate chapter_id.  For each book it
    fetches book metadata (1 call) to get latest_chapter/latest_index,
    then walks backwards from the latest chapter until it reaches the
    bundle's max index, recording chapter_ids along the way.

    Cost per book:
      - 0 new chapters since bundle was written → 1 API call (book meta)
        + 1 call (latest chapter) = 2 calls total
      - M new chapters → 1 + M+1 calls (walk back M+1 steps)

Usage:
    python3 migrate_v2.py                        # local only
    python3 migrate_v2.py --refetch              # also fetch chapter_ids
    python3 migrate_v2.py --refetch --workers 10 # parallel API fetches
    python3 migrate_v2.py --limit 100            # first 100 v1 bundles
    python3 migrate_v2.py --dry-run              # report only
    python3 migrate_v2.py --ids 100267 100358    # specific book IDs
"""

from __future__ import annotations

import argparse
import asyncio
import os
import struct
import sys
import time
from datetime import datetime
from pathlib import Path

from rich.console import Console
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)

# ─── Setup paths & imports ────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from src.bundle import (
    BUNDLE_MAGIC,
    BUNDLE_VERSION_1,
    BUNDLE_VERSION_2,
    HEADER_SIZE_V2,
    ChapterMeta,
    read_bundle_meta,
    read_bundle_raw,
    write_bundle,
)

BINSLIB_DIR = SCRIPT_DIR.parent / "binslib"
COMPRESSED_DIR = BINSLIB_DIR / "data" / "compressed"
DB_PATH = BINSLIB_DIR / "data" / "binslib.db"

LOG_DIR = SCRIPT_DIR / "data"
DETAIL_LOG = LOG_DIR / "migrate-v2-detail.log"

console = Console()


def timestamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def format_duration(seconds: float) -> str:
    s = int(seconds)
    if s < 60:
        return f"{s}s"
    m, sec = divmod(s, 60)
    if m < 60:
        return f"{m}m {sec}s"
    h, m = divmod(m, 60)
    return f"{h}h {m}m {sec}s"


def log_detail(msg: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(DETAIL_LOG, "a") as f:
        f.write(f"[{timestamp()}] {msg}\n")


# ─── Helpers ──────────────────────────────────────────────────────────────────


def read_bundle_version(path: str) -> int | None:
    """Read just the version field from a bundle file header."""
    try:
        with open(path, "rb") as f:
            hdr = f.read(8)
            if len(hdr) < 8 or hdr[:4] != BUNDLE_MAGIC:
                return None
            return struct.unpack_from("<I", hdr, 4)[0]
    except OSError:
        return None


def get_db_chapter_meta(db_path: str, book_id: int) -> dict[int, tuple[str, str, int]]:
    """Query chapter metadata from SQLite.

    Returns dict mapping index_num -> (title, slug, word_count).
    """
    import sqlite3

    try:
        conn = sqlite3.connect(db_path)
        rows = conn.execute(
            "SELECT index_num, title, slug, word_count FROM chapters WHERE book_id = ?",
            (book_id,),
        ).fetchall()
        conn.close()
        return {r[0]: (r[1] or "", r[2] or "", r[3] or 0) for r in rows}
    except Exception:
        return {}


def scan_v1_bundles(
    compressed_dir: str, book_ids: list[int] | None = None
) -> list[tuple[int, str]]:
    """Scan for v1 bundles.  Returns list of (book_id, path)."""
    results = []
    if not os.path.isdir(compressed_dir):
        return results

    for fname in sorted(os.listdir(compressed_dir)):
        if not fname.endswith(".bundle"):
            continue
        bid_str = fname[:-7]  # strip ".bundle"
        if not bid_str.isdigit():
            continue
        bid = int(bid_str)
        if book_ids is not None and bid not in book_ids:
            continue
        fpath = os.path.join(compressed_dir, fname)
        version = read_bundle_version(fpath)
        if version == BUNDLE_VERSION_1:
            results.append((bid, fpath))
    return results


# ─── Local migration (no API) ────────────────────────────────────────────────


def migrate_local(
    bundles: list[tuple[int, str]],
    db_path: str,
    dry_run: bool,
) -> dict[str, int]:
    """Convert v1 bundles to v2 using local DB metadata only."""
    stats = {"migrated": 0, "skipped_no_data": 0, "errors": 0}

    with Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Migrating v1 → v2", total=len(bundles))

        for book_id, bundle_path in bundles:
            try:
                # Read existing v1 data
                raw_data = read_bundle_raw(bundle_path)
                if not raw_data:
                    stats["skipped_no_data"] += 1
                    log_detail(f"SKIP {book_id}: empty bundle")
                    progress.advance(task)
                    continue

                # Get metadata from DB
                db_meta = get_db_chapter_meta(db_path, book_id)
                db_hits = sum(1 for idx in raw_data if idx in db_meta)

                # Build ChapterMeta for each chapter
                meta: dict[int, ChapterMeta] = {}
                for idx in raw_data:
                    if idx in db_meta:
                        title, slug, wc = db_meta[idx]
                        meta[idx] = ChapterMeta(
                            chapter_id=0, word_count=wc, title=title, slug=slug
                        )
                    else:
                        meta[idx] = ChapterMeta()

                if not dry_run:
                    write_bundle(bundle_path, raw_data, meta)

                stats["migrated"] += 1
                log_detail(
                    f"MIGRATE {book_id}: {len(raw_data)} chapters, "
                    f"{db_hits}/{len(raw_data)} with DB metadata"
                )
            except Exception as e:
                console.print(f"  [red]ERROR[/red] {book_id}: {e}")
                log_detail(f"ERROR {book_id}: {e}")
                stats["errors"] += 1

            progress.advance(task)

    return stats


# ─── Refetch migration (with API) ────────────────────────────────────────────


async def fetch_chapter_ids(
    book_id: int,
    max_bundle_index: int,
    workers: int,
) -> dict[int, int]:
    """Fetch chapter_id mapping for a book via API.

    Strategy:
      1. Fetch book metadata → latest_chapter, latest_index
      2. If latest_index == max_bundle_index → done (1 mapping)
      3. Otherwise walk backwards from latest_chapter to max_bundle_index

    Returns dict mapping index_num -> chapter_id.
    """
    from src.api import AsyncBookClient

    id_map: dict[int, int] = {}

    async with AsyncBookClient(max_concurrent=1, request_delay=0.05) as client:
        # Step 1: book metadata
        try:
            book = await client.get_book(book_id)
        except Exception:
            return id_map

        latest_chapter = book.get("latest_chapter")
        latest_index = book.get("latest_index", 0)

        if not latest_chapter:
            return id_map

        # Step 2: walk backwards from latest to our max index
        ch_id = latest_chapter
        while ch_id:
            try:
                chapter = await client.get_chapter(ch_id)
            except Exception:
                break

            idx = chapter.get("index", 0)
            id_map[idx] = chapter.get("id", 0)

            if idx <= max_bundle_index:
                break  # reached or passed our max index

            prev_info = chapter.get("previous")
            ch_id = prev_info.get("id") if prev_info else None

    return id_map


async def migrate_refetch(
    bundles: list[tuple[int, str]],
    db_path: str,
    workers: int,
    dry_run: bool,
) -> dict[str, int]:
    """Convert v1 bundles to v2, fetching chapter_ids from API."""
    stats = {"migrated": 0, "skipped_no_data": 0, "api_calls": 0, "errors": 0}
    sem = asyncio.Semaphore(workers)

    with Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Migrating v1 → v2 (refetch)", total=len(bundles))

        async def process_one(book_id: int, bundle_path: str):
            async with sem:
                try:
                    raw_data = read_bundle_raw(bundle_path)
                    if not raw_data:
                        stats["skipped_no_data"] += 1
                        log_detail(f"SKIP {book_id}: empty bundle")
                        progress.advance(task)
                        return

                    db_meta = get_db_chapter_meta(db_path, book_id)
                    max_idx = max(raw_data.keys())
                    db_hits = sum(1 for idx in raw_data if idx in db_meta)

                    # Fetch chapter_ids from API
                    id_map = await fetch_chapter_ids(book_id, max_idx, workers)
                    api_calls = len(id_map) + 1  # +1 for book metadata
                    stats["api_calls"] += api_calls
                    ids_found = sum(1 for v in id_map.values() if v > 0)

                    # Build ChapterMeta
                    meta: dict[int, ChapterMeta] = {}
                    for idx in raw_data:
                        title, slug, wc = db_meta.get(idx, ("", "", 0))
                        meta[idx] = ChapterMeta(
                            chapter_id=id_map.get(idx, 0),
                            word_count=wc,
                            title=title,
                            slug=slug,
                        )

                    if not dry_run:
                        await asyncio.to_thread(
                            write_bundle, bundle_path, raw_data, meta
                        )

                    stats["migrated"] += 1
                    log_detail(
                        f"MIGRATE {book_id}: {len(raw_data)} chapters, "
                        f"{db_hits}/{len(raw_data)} DB meta, "
                        f"{ids_found} ch_ids fetched ({api_calls} API calls)"
                    )
                except Exception as e:
                    console.print(f"  [red]ERROR[/red] {book_id}: {e}")
                    log_detail(f"ERROR {book_id}: {e}")
                    stats["errors"] += 1

                progress.advance(task)

        tasks = [process_one(bid, path) for bid, path in bundles]
        await asyncio.gather(*tasks)

    return stats


# ─── CLI ──────────────────────────────────────────────────────────────────────


def parse_args():
    parser = argparse.ArgumentParser(description="Migrate BLIB v1 bundles to v2 format")
    parser.add_argument(
        "--refetch",
        action="store_true",
        default=False,
        help="Fetch chapter_ids from API (default: local DB only, chapter_id=0)",
    )
    parser.add_argument(
        "--workers",
        "-w",
        type=int,
        default=5,
        help="Parallel API workers for --refetch mode (default: 5)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Limit to first N v1 bundles (0 = all)",
    )
    parser.add_argument(
        "--ids",
        nargs="+",
        type=int,
        default=None,
        help="Specific book IDs to migrate",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Report what would be done without writing",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    if not DB_PATH.exists():
        console.print(f"[red]Error:[/red] Database not found: {DB_PATH}")
        sys.exit(1)
    if not COMPRESSED_DIR.exists():
        console.print(f"[red]Error:[/red] Compressed dir not found: {COMPRESSED_DIR}")
        sys.exit(1)

    # Scan for v1 bundles
    console.print(f"\n[bold]migrate_v2[/bold] — scanning for v1 bundles...")
    bundles = scan_v1_bundles(str(COMPRESSED_DIR), args.ids)

    if args.limit > 0:
        bundles = bundles[: args.limit]

    # Also count v2 bundles for the report
    total_bundles = len(
        [f for f in os.listdir(str(COMPRESSED_DIR)) if f.endswith(".bundle")]
    )
    v2_count = total_bundles - len(scan_v1_bundles(str(COMPRESSED_DIR), args.ids))

    console.print(
        f"  Total bundles: {total_bundles:,}\n"
        f"  Already v2:    {v2_count:,}\n"
        f"  v1 to migrate: {len(bundles):,}\n"
        f"  Mode:          {'refetch (API)' if args.refetch else 'local (DB only)'}"
        f"{'  [yellow](dry run)[/yellow]' if args.dry_run else ''}\n"
    )

    if not bundles:
        console.print("[green]Nothing to migrate![/green]\n")
        return

    # Start banner
    mode_str = "refetch (API)" if args.refetch else "local (DB only)"
    log_detail("=" * 60)
    log_detail(
        f"Migration started — {mode_str}, {len(bundles):,} v1 bundles"
        f"{' (dry run)' if args.dry_run else ''}"
    )
    log_detail("=" * 60)

    start = time.time()

    if args.refetch:
        stats = asyncio.run(
            migrate_refetch(bundles, str(DB_PATH), args.workers, args.dry_run)
        )
    else:
        stats = migrate_local(bundles, str(DB_PATH), args.dry_run)

    elapsed = time.time() - start

    # Summary log
    log_detail("─" * 40)
    summary = (
        f"Migrated: {stats['migrated']:,}, "
        f"Skipped: {stats.get('skipped_no_data', 0):,}, "
        f"Errors: {stats['errors']:,}"
    )
    if args.refetch:
        summary += f", API calls: {stats.get('api_calls', 0):,}"
    log_detail(summary)
    log_detail("=" * 60)
    log_detail(
        f"COMPLETED in {format_duration(elapsed)}: {stats['migrated']:,} migrated, "
        f"{stats['errors']:,} errors"
    )
    log_detail("=" * 60 + "\n")

    # Console report
    console.print(
        f"\n[bold]{'Dry-run report' if args.dry_run else 'Migration complete'}[/bold]"
    )
    console.print(f"  Migrated:     {stats['migrated']:,}")
    console.print(f"  Skipped:      {stats.get('skipped_no_data', 0):,}  (no data)")
    console.print(f"  Errors:       {stats['errors']:,}")
    if args.refetch:
        console.print(f"  API calls:    {stats.get('api_calls', 0):,}")
    console.print(f"  Duration:     {format_duration(elapsed)}")
    console.print(f"  Detail log:   {DETAIL_LOG}")
    console.print()

    # Verify a sample
    if stats["migrated"] > 0 and not args.dry_run:
        sample_bid, sample_path = bundles[0]
        v = read_bundle_version(sample_path)
        meta = read_bundle_meta(sample_path)
        sample_meta = next(iter(meta.values())) if meta else None
        console.print(f"  [dim]Sample verification: book {sample_bid}[/dim]")
        console.print(f"    version={v}, chapters={len(meta)}")
        if sample_meta:
            console.print(
                f"    first meta: ch_id={sample_meta.chapter_id} "
                f'wc={sample_meta.word_count} "{sample_meta.title[:40]}"'
            )
        console.print()


if __name__ == "__main__":
    main()
