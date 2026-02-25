#!/usr/bin/env python3
"""
Pull catalog metadata and cover images for the MTC book platform.

Discovers books from binslib bundle files (not crawler/output). Supports
two independent operations that can be combined:

  --meta-only   Paginate the full API catalog, cross-reference with local
                bundles, and write a download plan to book-ingest/data/.
  --cover-only  Download missing cover images to binslib/public/covers/.

Running without flags performs both operations.

Usage:
    python3 pull_metadata.py                        # meta + covers
    python3 pull_metadata.py --meta-only            # update plan file only
    python3 pull_metadata.py --cover-only            # pull missing covers
    python3 pull_metadata.py --cover-only --ids 132599 131197
    python3 pull_metadata.py --cover-only --force    # re-download all covers
    python3 pull_metadata.py --dry-run               # preview without writing
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import time
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

# ── Config (inline — no external imports) ───────────────────────────────────

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
PLAN_DIR = SCRIPT_DIR.parent / "book-ingest" / "data"
PLAN_FILE = PLAN_DIR / "fresh_books_download.json"

console = Console()

# ── Bundle helpers (minimal BLIB reader) ────────────────────────────────────

BUNDLE_MAGIC = b"BLIB"
_HEADER_MIN = 12  # magic(4) + version(4) + count(4)
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


def read_bundle_indices(bundle_path: Path) -> set[int]:
    """Read chapter index numbers from a BLIB bundle (v1 or v2)."""
    try:
        with open(bundle_path, "rb") as f:
            hdr = f.read(16)
            if len(hdr) < _HEADER_MIN or hdr[:4] != BUNDLE_MAGIC:
                return set()
            version = struct.unpack_from("<I", hdr, 4)[0]
            count = struct.unpack_from("<I", hdr, 8)[0]
            if count == 0:
                return set()
            header_size = 16 if version >= 2 else 12
            f.seek(header_size)
            idx_buf = f.read(count * _ENTRY_SIZE)
            if len(idx_buf) < count * _ENTRY_SIZE:
                return set()
            indices: set[int] = set()
            for i in range(count):
                index_num = struct.unpack_from("<I", idx_buf, i * _ENTRY_SIZE)[0]
                indices.add(index_num)
            return indices
    except OSError:
        return set()


# ── Book discovery ──────────────────────────────────────────────────────────


def get_bundle_book_ids() -> list[int]:
    """Scan binslib/data/compressed/ for .bundle files, return sorted IDs."""
    ids: list[int] = []
    if not COMPRESSED_DIR.is_dir():
        return ids
    for f in COMPRESSED_DIR.iterdir():
        if f.suffix == ".bundle" and f.stem.isdigit():
            ids.append(int(f.stem))
    return sorted(ids)


def bundle_path_for(book_id: int) -> Path:
    return COMPRESSED_DIR / f"{book_id}.bundle"


# ── API helpers ─────────────────────────────────────────────────────────────


def fetch_book_metadata(client: httpx.Client, book_id: int) -> dict | None:
    """Fetch full book metadata from API by ID.

    Tries GET /api/books/{id} first, falls back to search.
    """
    includes = "author,creator,genres"

    # Direct lookup
    try:
        r = client.get(f"{BASE_URL}/api/books/{book_id}", params={"include": includes})
        if r.status_code == 200:
            data = r.json()
            if data.get("success") and data.get("data"):
                book = data["data"]
                if "book" in book and isinstance(book["book"], dict):
                    book = book["book"]
                return book
    except Exception as e:
        console.print(f"    [dim]/api/books/{book_id}: {e}[/dim]")

    return None


def fetch_all_books(
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
            all_books.append(
                {
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
            )

        if page % 50 == 0 or page == 1:
            log(f"  Page {page}/{last_page}: {len(all_books)} books collected")

        if not pag.get("next"):
            break
        page += 1
        time.sleep(0.08)

    log(f"  Done: {len(all_books)} books fetched")
    return all_books


def download_cover(client: httpx.Client, poster: dict, dest_path: str) -> bool:
    """Download the best available cover image.

    poster dict has keys like 'default', '600', '300', '150' with URLs.
    """
    for key in ["default", "600", "300", "150"]:
        url = poster.get(key)
        if not url:
            continue
        try:
            r = client.get(url, follow_redirects=True, timeout=30)
            if r.status_code == 200 and len(r.content) > 100:
                with open(dest_path, "wb") as f:
                    f.write(r.content)
                return True
        except Exception as e:
            console.print(f"    [dim]Cover download ({key}): {e}[/dim]")
    return False


# ── Meta-only: catalog → plan file ─────────────────────────────────────────


def generate_plan(client: httpx.Client, dry_run: bool = False) -> dict:
    """Fetch full catalog, cross-reference with local bundles, write plan."""
    console.print("\n[bold blue]Fetching API catalog...[/bold blue]")
    catalog = fetch_all_books(client)

    # Build local chapter counts from bundles
    console.print("[bold blue]Scanning local bundles...[/bold blue]")
    known_bids: dict[int, int] = {}
    if COMPRESSED_DIR.is_dir():
        for f in COMPRESSED_DIR.iterdir():
            if f.suffix == ".bundle" and f.stem.isdigit():
                bid = int(f.stem)
                count = read_bundle_chapter_count(f)
                if count > 0:
                    known_bids[bid] = count
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

    # Build plan result
    result = {
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
                "slug": b.get("slug", ""),
                "chapter_count": b["chapter_count"],
                "first_chapter": b["first_chapter"],
                "status": b.get("status", "?"),
                "kind": b.get("kind"),
                "sex": b.get("sex"),
                "word_count": b.get("word_count", 0),
                "local": b["local"],
                "gap": b["gap"],
            }
            for b in sorted(have_partial, key=lambda x: -x["gap"])
        ],
    }

    # Show top needs
    if need_download:
        nd = sorted(need_download, key=lambda x: -x.get("chapter_count", 0))
        console.print(f"\n[bold]Top 15 books to download:[/bold]")
        for b in nd[:15]:
            console.print(f"  {b['id']:>7} ch={b['chapter_count']:>5} {b['name'][:50]}")

    if have_partial:
        console.print(f"\n[bold]Partial downloads (top 15 by gap):[/bold]")
        for b in result["partial"][:15]:
            console.print(
                f"  {b['id']:>7} {b['local']:>5}/{b['chapter_count']:<5} "
                f"gap={b['gap']:>5} {b['name'][:42]}"
            )

    if dry_run:
        console.print(f"\n[yellow]Dry run — plan file not written.[/yellow]")
        return result

    # Write the plan file (flat array for book-ingest compatibility)
    # Combine need_download + partial into a single list
    plan_entries: list[dict] = []
    for b in need_download:
        plan_entries.append(b)
    for b in result["partial"]:
        # Remove internal fields, keep what book-ingest expects
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

    # Also save the full audit result alongside
    audit_file = PLAN_DIR / "catalog_audit.json"
    with open(audit_file, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    console.print(f"  Audit saved: {audit_file}")

    return result


# ── Cover-only: download covers ────────────────────────────────────────────


def pull_cover_for_book(client: httpx.Client, book_id: int, log=console.print) -> bool:
    """Download cover directly to binslib/public/covers/{book_id}.jpg.

    Fetches poster URL from the API.
    """
    dest_path = str(COVERS_DIR / f"{book_id}.jpg")

    book = fetch_book_metadata(client, book_id)
    if not book:
        log(f"  [red]FAILED[/red] {book_id}: no API data")
        return False

    poster = book.get("poster")
    if not poster:
        log(f"  [yellow]WARNING[/yellow] {book_id}: no poster info")
        return False

    if isinstance(poster, dict):
        if download_cover(client, poster, dest_path):
            return True
        log(f"  [yellow]WARNING[/yellow] {book_id}: cover download failed")
        return False

    if isinstance(poster, str):
        try:
            r = client.get(poster, follow_redirects=True, timeout=30)
            if r.status_code == 200 and len(r.content) > 100:
                with open(dest_path, "wb") as f:
                    f.write(r.content)
                return True
        except Exception as e:
            log(f"  [yellow]WARNING[/yellow] {book_id}: cover failed: {e}")

    return False


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


# ── Main ────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Pull catalog metadata and cover images for MTC books.\n\n"
        "Discovers books from binslib bundle files. Supports --meta-only\n"
        "(generate download plan) and --cover-only (download covers).\n"
        "Default (no flags) performs both operations.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--ids",
        type=int,
        nargs="+",
        help="Specific book IDs (applies to --cover-only; ignored by --meta-only)",
    )
    parser.add_argument(
        "--meta-only",
        action="store_true",
        help="Only update the download plan (fresh_books_download.json)",
    )
    parser.add_argument(
        "--cover-only",
        action="store_true",
        help="Only download covers to binslib/public/covers/",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-download covers even if they exist",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without making changes",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=REQUEST_DELAY,
        help=f"Seconds between API requests (default: {REQUEST_DELAY})",
    )
    args = parser.parse_args()

    # Determine mode
    do_meta = not args.cover_only  # meta runs unless --cover-only
    do_covers = not args.meta_only  # covers run unless --meta-only

    console.print(
        Panel(
            "[bold]MTC Metadata Puller[/bold]",
            subtitle="meta + covers"
            if (do_meta and do_covers)
            else "meta only"
            if do_meta
            else "covers only",
            border_style="blue",
            expand=False,
        )
    )

    # ── Meta-only / meta phase ──────────────────────────────────────────
    if do_meta:
        with httpx.Client(headers=HEADERS, timeout=30) as client:
            generate_plan(client, dry_run=args.dry_run)

    # ── Cover-only / cover phase ────────────────────────────────────────
    if do_covers:
        if args.ids:
            target_ids = sorted(args.ids)
        else:
            target_ids = get_bundle_book_ids()

        if not target_ids:
            console.print(f"[yellow]No bundle files found in {COMPRESSED_DIR}[/yellow]")
            return

        console.print(f"\n[bold blue]Cover Pull[/bold blue]")
        console.print(f"  Source:         [dim]bundles in {COMPRESSED_DIR}[/dim]")
        console.print(f"  Books found:    [bold]{len(target_ids)}[/bold]")
        run_cover_pull(target_ids, args.force, args.dry_run, args.delay)


if __name__ == "__main__":
    main()
