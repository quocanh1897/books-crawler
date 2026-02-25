#!/usr/bin/env python3
"""migrate_v2.py — Migrate BLIB bundles and sync DB chapter rows.

Two responsibilities:
  1. Convert v1 bundles to v2 format (inline per-chapter metadata)
  2. Fill missing DB chapter rows by decompressing bundle content

Skips books that are already v2 AND have all DB chapter rows present.

Modes:
  Default (local only):
    Metadata sourced from bundle content (decompress to extract title,
    word_count).  chapter_id = 0 for all chapters (unknown without API).

  --refetch:
    Also calls the MTC API to populate chapter_id for the highest-index
    chapter in each bundle.  This enables the resume-walk optimisation
    in ingest.py on subsequent runs.

    Cost per book:
      - latest_index == max bundle index → 1 API call (book meta only)
      - M new chapters on server → 1 + M+1 calls (walk back to our max)

Usage:
    python3 migrate_v2.py                        # local only
    python3 migrate_v2.py --refetch              # also fetch chapter_ids
    python3 migrate_v2.py --refetch -w 10        # parallel API fetches
    python3 migrate_v2.py --limit 100            # first 100 books needing work
    python3 migrate_v2.py --ids 100267 100358    # specific book IDs
    python3 migrate_v2.py --dry-run              # report only
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import sqlite3
import struct
import sys
import time
from datetime import datetime
from pathlib import Path

import pyzstd
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
    META_ENTRY_SIZE,
    ChapterMeta,
    read_bundle_indices,
    read_bundle_meta,
    read_bundle_raw,
    write_bundle,
)

BINSLIB_DIR = SCRIPT_DIR.parent / "binslib"
COMPRESSED_DIR = BINSLIB_DIR / "data" / "compressed"
DB_PATH = BINSLIB_DIR / "data" / "binslib.db"
DICT_PATH = BINSLIB_DIR / "data" / "global.dict"

LOG_DIR = SCRIPT_DIR / "data"
DETAIL_LOG = LOG_DIR / "migrate-v2-detail.log"

console = Console()

# ─── Helpers ──────────────────────────────────────────────────────────────────


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


def slugify_index(index_num: int) -> str:
    return f"chuong-{index_num}"


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


def load_decompressor(dict_path: str) -> pyzstd.ZstdDict | None:
    """Load the zstd dictionary for decompressing chapter content."""
    if os.path.exists(dict_path):
        with open(dict_path, "rb") as f:
            return pyzstd.ZstdDict(f.read())
    return None


def decompress_chapter(
    compressed: bytes, zstd_dict: pyzstd.ZstdDict | None
) -> str | None:
    """Decompress a single chapter body. Returns UTF-8 text or None."""
    try:
        if zstd_dict:
            raw = pyzstd.decompress(compressed, zstd_dict=zstd_dict)
        else:
            raw = pyzstd.decompress(compressed)
        return raw.decode("utf-8", errors="replace")
    except Exception:
        return None


def extract_chapter_meta(body: str, index_num: int) -> tuple[str, str, int]:
    """Extract (title, slug, word_count) from a decompressed chapter body."""
    lines = body.split("\n")
    title = f"Chương {index_num}"
    for line in lines:
        stripped = line.strip()
        if stripped:
            title = stripped
            break
    word_count = len(body.split())
    slug = slugify_index(index_num)
    return title, slug, word_count


# ─── Scanning ─────────────────────────────────────────────────────────────────


class BookWork:
    """Describes the work needed for a single book."""

    __slots__ = ("book_id", "bundle_path", "version", "needs_v2", "missing_db_indices")

    def __init__(
        self,
        book_id: int,
        bundle_path: str,
        version: int,
        needs_v2: bool,
        missing_db_indices: set[int],
    ):
        self.book_id = book_id
        self.bundle_path = bundle_path
        self.version = version
        self.needs_v2 = needs_v2
        self.missing_db_indices = missing_db_indices

    @property
    def needs_work(self) -> bool:
        return self.needs_v2 or len(self.missing_db_indices) > 0


def scan_bundles(
    compressed_dir: str,
    db_path: str,
    book_ids: list[int] | None = None,
) -> tuple[list[BookWork], int, int, int]:
    """Scan all bundles and determine what work is needed.

    Returns (work_items, total_bundles, already_complete, books_no_row).
    """
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")

    work: list[BookWork] = []
    total = 0
    complete = 0
    no_book_row = 0

    for fname in sorted(os.listdir(compressed_dir)):
        if not fname.endswith(".bundle"):
            continue
        bid_str = fname[:-7]
        if not bid_str.isdigit():
            continue
        bid = int(bid_str)
        if book_ids is not None and bid not in book_ids:
            continue

        total += 1
        fpath = os.path.join(compressed_dir, fname)
        version = read_bundle_version(fpath)
        if version is None:
            continue

        needs_v2 = version == BUNDLE_VERSION_1

        # Check if book row exists (FK requirement for chapter inserts)
        book_row = conn.execute("SELECT id FROM books WHERE id = ?", (bid,)).fetchone()

        if book_row is None:
            # No book row → can't sync chapters to DB, but can still do v2 migration
            if needs_v2:
                item = BookWork(bid, fpath, version, True, set())
                work.append(item)
                no_book_row += 1
            else:
                complete += 1
                no_book_row += 1
            continue

        # Compare bundle indices vs DB chapter rows
        bundle_idx = read_bundle_indices(fpath)
        db_rows = conn.execute(
            "SELECT index_num FROM chapters WHERE book_id = ?", (bid,)
        ).fetchall()
        db_indices = {r[0] for r in db_rows}
        missing = bundle_idx - db_indices

        if not needs_v2 and not missing:
            complete += 1
            continue

        work.append(BookWork(bid, fpath, version, needs_v2, missing))

    conn.close()
    return work, total, complete, no_book_row


# ─── Migration ────────────────────────────────────────────────────────────────


def migrate_books(
    work_items: list[BookWork],
    db_path: str,
    dict_path: str,
    refetch: bool,
    workers: int,
    dry_run: bool,
) -> dict[str, int]:
    """Run migration: v1→v2 conversion + DB chapter sync."""
    if refetch:
        return asyncio.run(
            _migrate_refetch(work_items, db_path, dict_path, workers, dry_run)
        )
    else:
        return _migrate_local(work_items, db_path, dict_path, dry_run)


def _migrate_local(
    work_items: list[BookWork],
    db_path: str,
    dict_path: str,
    dry_run: bool,
) -> dict[str, int]:
    """Local migration: no API calls."""
    stats = {
        "v2_migrated": 0,
        "db_synced": 0,
        "db_rows_added": 0,
        "skipped_empty": 0,
        "errors": 0,
    }

    zstd_dict = load_decompressor(dict_path)
    conn = sqlite3.connect(db_path) if not dry_run else None
    if conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")

    insert_stmt = (
        "INSERT OR IGNORE INTO chapters "
        "(book_id, index_num, title, slug, word_count) "
        "VALUES (?, ?, ?, ?, ?)"
    )

    with Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Migrating", total=len(work_items))

        for item in work_items:
            try:
                _process_one_local(item, stats, zstd_dict, conn, insert_stmt, dry_run)
            except Exception as e:
                console.print(f"  [red]ERROR[/red] {item.book_id}: {e}")
                log_detail(f"ERROR {item.book_id}: {e}")
                stats["errors"] += 1

            progress.advance(task)

    if conn:
        conn.close()

    return stats


def _process_one_local(
    item: BookWork,
    stats: dict[str, int],
    zstd_dict: pyzstd.ZstdDict | None,
    conn: sqlite3.Connection | None,
    insert_stmt: str,
    dry_run: bool,
) -> None:
    """Process a single book: v2 migration + DB sync."""
    book_id = item.book_id
    bundle_path = item.bundle_path
    did_v2 = False
    db_rows_added = 0
    log_parts: list[str] = []

    # ── Phase 1: v1 → v2 bundle migration ────────────────────────────────

    if item.needs_v2:
        raw_data = read_bundle_raw(bundle_path)
        if not raw_data:
            stats["skipped_empty"] += 1
            log_detail(f"SKIP {book_id}: empty bundle")
            return

        # Build metadata from DB first, fall back to decompression
        db_meta = _get_db_chapter_meta(conn, book_id) if conn else {}
        meta: dict[int, ChapterMeta] = {}

        for idx, (compressed, raw_len) in raw_data.items():
            if idx in db_meta:
                title, slug, wc = db_meta[idx]
                meta[idx] = ChapterMeta(
                    chapter_id=0, word_count=wc, title=title, slug=slug
                )
            else:
                # Decompress to extract title
                body = decompress_chapter(compressed, zstd_dict)
                if body:
                    title, slug, wc = extract_chapter_meta(body, idx)
                    meta[idx] = ChapterMeta(
                        chapter_id=0, word_count=wc, title=title, slug=slug
                    )
                else:
                    meta[idx] = ChapterMeta()

        if not dry_run:
            write_bundle(bundle_path, raw_data, meta)

        stats["v2_migrated"] += 1
        did_v2 = True
        log_parts.append(f"v1→v2 ({len(raw_data)} ch)")

    # ── Phase 2: fill missing DB chapter rows ────────────────────────────

    if item.missing_db_indices and conn is not None:
        # For v2 bundles (including ones we just migrated), try bundle
        # metadata first — it may already have titles from phase 1.
        bundle_meta = read_bundle_meta(bundle_path)

        # Chapters whose metadata is usable from the bundle
        from_meta = 0
        # Chapters that need decompression
        from_decompress = 0

        # We may need raw data if decompression is required
        raw_data_for_decompress: dict[int, tuple[bytes, int]] | None = None

        for idx in item.missing_db_indices:
            m = bundle_meta.get(idx)
            if m and m.title:
                # Good metadata in bundle — use it directly
                if not dry_run:
                    conn.execute(
                        insert_stmt,
                        (
                            book_id,
                            idx,
                            m.title,
                            m.slug or slugify_index(idx),
                            m.word_count,
                        ),
                    )
                from_meta += 1
                db_rows_added += 1
            else:
                # Need to decompress this chapter to extract title
                if raw_data_for_decompress is None:
                    raw_data_for_decompress = read_bundle_raw(bundle_path)

                entry = raw_data_for_decompress.get(idx)
                if entry is None:
                    continue

                compressed, _ = entry
                body = decompress_chapter(compressed, zstd_dict)
                if body:
                    title, slug, wc = extract_chapter_meta(body, idx)
                    if not dry_run:
                        conn.execute(insert_stmt, (book_id, idx, title, slug, wc))
                    db_rows_added += 1
                    from_decompress += 1

        if not dry_run:
            conn.commit()

        if db_rows_added > 0:
            stats["db_synced"] += 1
            stats["db_rows_added"] += db_rows_added
            parts = []
            if from_meta:
                parts.append(f"{from_meta} from meta")
            if from_decompress:
                parts.append(f"{from_decompress} decompressed")
            log_parts.append(f"+{db_rows_added} DB rows ({', '.join(parts)})")

    if log_parts:
        log_detail(f"MIGRATE {book_id}: {'; '.join(log_parts)}")


def _get_db_chapter_meta(
    conn: sqlite3.Connection | None, book_id: int
) -> dict[int, tuple[str, str, int]]:
    """Query existing chapter metadata from DB."""
    if conn is None:
        return {}
    rows = conn.execute(
        "SELECT index_num, title, slug, word_count FROM chapters WHERE book_id = ?",
        (book_id,),
    ).fetchall()
    return {r[0]: (r[1] or "", r[2] or "", r[3] or 0) for r in rows}


# ─── Refetch migration (with API) ────────────────────────────────────────────


async def _fetch_chapter_ids(
    book_id: int,
    max_bundle_index: int,
) -> dict[int, int]:
    """Fetch chapter_id mapping via API (walk backwards from latest).

    Returns dict mapping index_num -> chapter_id.
    """
    from src.api import AsyncBookClient

    id_map: dict[int, int] = {}

    async with AsyncBookClient(max_concurrent=1, request_delay=0.05) as client:
        try:
            book = await client.get_book(book_id)
        except Exception:
            return id_map

        latest_chapter = book.get("latest_chapter")
        if not latest_chapter:
            return id_map

        ch_id = latest_chapter
        while ch_id:
            try:
                chapter = await client.get_chapter(ch_id)
            except Exception:
                break

            idx = chapter.get("index", 0)
            id_map[idx] = chapter.get("id", 0)

            if idx <= max_bundle_index:
                break

            prev_info = chapter.get("previous")
            ch_id = prev_info.get("id") if prev_info else None

    return id_map


async def _migrate_refetch(
    work_items: list[BookWork],
    db_path: str,
    dict_path: str,
    workers: int,
    dry_run: bool,
) -> dict[str, int]:
    """Migration with API refetch for chapter_ids."""
    stats = {
        "v2_migrated": 0,
        "db_synced": 0,
        "db_rows_added": 0,
        "api_calls": 0,
        "skipped_empty": 0,
        "errors": 0,
    }

    zstd_dict = load_decompressor(dict_path)
    conn = sqlite3.connect(db_path) if not dry_run else None
    if conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")

    insert_stmt = (
        "INSERT OR IGNORE INTO chapters "
        "(book_id, index_num, title, slug, word_count) "
        "VALUES (?, ?, ?, ?, ?)"
    )

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
        task = progress.add_task("Migrating (refetch)", total=len(work_items))

        async def process_one(item: BookWork):
            async with sem:
                try:
                    await _process_one_refetch(
                        item, stats, zstd_dict, conn, insert_stmt, dry_run
                    )
                except Exception as e:
                    console.print(f"  [red]ERROR[/red] {item.book_id}: {e}")
                    log_detail(f"ERROR {item.book_id}: {e}")
                    stats["errors"] += 1

                progress.advance(task)

        tasks = [process_one(item) for item in work_items]
        await asyncio.gather(*tasks)

    if conn:
        conn.close()

    return stats


async def _process_one_refetch(
    item: BookWork,
    stats: dict[str, int],
    zstd_dict: pyzstd.ZstdDict | None,
    conn: sqlite3.Connection | None,
    insert_stmt: str,
    dry_run: bool,
) -> None:
    """Process a single book with API refetch for chapter_ids."""
    book_id = item.book_id
    bundle_path = item.bundle_path
    db_rows_added = 0
    log_parts: list[str] = []

    raw_data = read_bundle_raw(bundle_path)
    if not raw_data:
        stats["skipped_empty"] += 1
        log_detail(f"SKIP {book_id}: empty bundle")
        return

    max_idx = max(raw_data.keys())

    # Fetch chapter_ids from API
    id_map = await _fetch_chapter_ids(book_id, max_idx)
    api_calls = len(id_map) + 1  # +1 for book metadata call
    stats["api_calls"] += api_calls
    ids_found = sum(1 for v in id_map.values() if v > 0)

    # ── Phase 1: v1 → v2 with chapter_ids ────────────────────────────────

    if item.needs_v2:
        db_meta = _get_db_chapter_meta(conn, book_id) if conn else {}
        meta: dict[int, ChapterMeta] = {}

        for idx, (compressed, raw_len) in raw_data.items():
            ch_id = id_map.get(idx, 0)
            if idx in db_meta:
                title, slug, wc = db_meta[idx]
                meta[idx] = ChapterMeta(
                    chapter_id=ch_id, word_count=wc, title=title, slug=slug
                )
            else:
                body = decompress_chapter(compressed, zstd_dict)
                if body:
                    title, slug, wc = extract_chapter_meta(body, idx)
                    meta[idx] = ChapterMeta(
                        chapter_id=ch_id, word_count=wc, title=title, slug=slug
                    )
                else:
                    meta[idx] = ChapterMeta(chapter_id=ch_id)

        if not dry_run:
            await asyncio.to_thread(write_bundle, bundle_path, raw_data, meta)

        stats["v2_migrated"] += 1
        log_parts.append(f"v1→v2 ({len(raw_data)} ch, {ids_found} ch_ids)")

    elif ids_found > 0:
        # Already v2 but we fetched chapter_ids — update the bundle metadata
        existing_meta = read_bundle_meta(bundle_path)
        updated = False
        for idx, ch_id in id_map.items():
            if ch_id and idx in existing_meta:
                m = existing_meta[idx]
                if m.chapter_id != ch_id:
                    existing_meta[idx] = ChapterMeta(
                        chapter_id=ch_id,
                        word_count=m.word_count,
                        title=m.title,
                        slug=m.slug,
                    )
                    updated = True

        if updated and not dry_run:
            await asyncio.to_thread(write_bundle, bundle_path, raw_data, existing_meta)
            log_parts.append(f"ch_ids updated ({ids_found}, {api_calls} API)")

    # ── Phase 2: fill missing DB chapter rows ────────────────────────────

    if item.missing_db_indices and conn is not None:
        bundle_meta = read_bundle_meta(bundle_path)

        for idx in item.missing_db_indices:
            m = bundle_meta.get(idx)
            if m and m.title:
                if not dry_run:
                    conn.execute(
                        insert_stmt,
                        (
                            book_id,
                            idx,
                            m.title,
                            m.slug or slugify_index(idx),
                            m.word_count,
                        ),
                    )
                db_rows_added += 1
            else:
                entry = raw_data.get(idx)
                if entry is None:
                    continue
                compressed, _ = entry
                body = decompress_chapter(compressed, zstd_dict)
                if body:
                    title, slug, wc = extract_chapter_meta(body, idx)
                    if not dry_run:
                        conn.execute(insert_stmt, (book_id, idx, title, slug, wc))
                    db_rows_added += 1

        if not dry_run:
            conn.commit()

        if db_rows_added > 0:
            stats["db_synced"] += 1
            stats["db_rows_added"] += db_rows_added
            log_parts.append(f"+{db_rows_added} DB rows")

    if log_parts:
        log_detail(f"MIGRATE {book_id}: {'; '.join(log_parts)}")


# ─── CLI ──────────────────────────────────────────────────────────────────────


def parse_args():
    parser = argparse.ArgumentParser(
        description="Migrate BLIB v1 bundles to v2 and sync DB chapter rows"
    )
    parser.add_argument(
        "--refetch",
        action="store_true",
        default=False,
        help="Fetch chapter_ids from API (default: local only, chapter_id=0)",
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
        help="Limit to first N books needing work (0 = all)",
    )
    parser.add_argument(
        "--ids",
        nargs="+",
        type=int,
        default=None,
        help="Specific book IDs to process",
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

    # ── Scan ──────────────────────────────────────────────────────────────

    console.print("\n[bold]migrate_v2[/bold] — scanning bundles...")
    scan_start = time.time()
    work_items, total_bundles, already_complete, no_book_row = scan_bundles(
        str(COMPRESSED_DIR), str(DB_PATH), args.ids
    )
    scan_elapsed = time.time() - scan_start

    v1_count = sum(1 for w in work_items if w.needs_v2)
    db_gap_count = sum(1 for w in work_items if w.missing_db_indices)
    total_missing_rows = sum(len(w.missing_db_indices) for w in work_items)

    if args.limit > 0:
        work_items = work_items[: args.limit]

    mode_str = "refetch (API)" if args.refetch else "local"
    console.print(
        f"  Scanned {total_bundles:,} bundles in {scan_elapsed:.1f}s\n"
        f"  Already complete:      {already_complete:,}\n"
        f"  Need v1→v2 migration:  {v1_count:,}\n"
        f"  Need DB chapter sync:  {db_gap_count:,}  ({total_missing_rows:,} missing rows)\n"
        f"  No book row in DB:     {no_book_row:,}  (DB sync skipped)\n"
        f"  Total needing work:    {len(work_items):,}\n"
        f"  Mode:                  {mode_str}"
        f"{'  [yellow](dry run)[/yellow]' if args.dry_run else ''}\n"
    )

    if not work_items:
        console.print("[green]Nothing to do![/green]\n")
        return

    # ── Start banner ──────────────────────────────────────────────────────

    log_detail("=" * 60)
    log_detail(
        f"Migration started — {mode_str}, "
        f"{len(work_items):,} books ({v1_count} v1→v2, {db_gap_count} DB sync)"
        f"{' (dry run)' if args.dry_run else ''}"
    )
    log_detail("=" * 60)

    # ── Run ───────────────────────────────────────────────────────────────

    start = time.time()

    stats = migrate_books(
        work_items,
        str(DB_PATH),
        str(DICT_PATH),
        refetch=args.refetch,
        workers=args.workers,
        dry_run=args.dry_run,
    )

    elapsed = time.time() - start

    # ── Summary log ───────────────────────────────────────────────────────

    log_detail("─" * 40)
    parts = [
        f"v2 migrated: {stats['v2_migrated']:,}",
        f"DB synced: {stats['db_synced']:,} books (+{stats['db_rows_added']:,} rows)",
        f"Errors: {stats['errors']:,}",
    ]
    if args.refetch:
        parts.append(f"API calls: {stats.get('api_calls', 0):,}")
    log_detail(", ".join(parts))
    log_detail("=" * 60)
    log_detail(f"COMPLETED in {format_duration(elapsed)}")
    log_detail("=" * 60 + "\n")

    # ── Console report ────────────────────────────────────────────────────

    label = "Dry-run report" if args.dry_run else "Migration complete"
    console.print(f"\n[bold]{label}[/bold]")
    console.print(f"  v2 migrated:    {stats['v2_migrated']:,}")
    console.print(
        f"  DB synced:      {stats['db_synced']:,} books  "
        f"(+{stats['db_rows_added']:,} chapter rows)"
    )
    console.print(f"  Skipped empty:  {stats.get('skipped_empty', 0):,}")
    console.print(f"  Errors:         {stats['errors']:,}")
    if args.refetch:
        console.print(f"  API calls:      {stats.get('api_calls', 0):,}")
    console.print(f"  Duration:       {format_duration(elapsed)}")
    console.print(f"  Detail log:     {DETAIL_LOG}")

    # ── Sample verification ───────────────────────────────────────────────

    if (stats["v2_migrated"] > 0 or stats["db_synced"] > 0) and not args.dry_run:
        sample = work_items[0]
        v = read_bundle_version(sample.bundle_path)
        meta = read_bundle_meta(sample.bundle_path)
        first_meta = next(iter(meta.values())) if meta else None
        console.print(f"\n  [dim]Sample: book {sample.book_id}[/dim]")
        console.print(f"    version={v}, chapters={len(meta)}")
        if first_meta:
            console.print(
                f"    first: ch_id={first_meta.chapter_id} "
                f'wc={first_meta.word_count} "{first_meta.title[:40]}"'
            )
    console.print()


if __name__ == "__main__":
    main()
