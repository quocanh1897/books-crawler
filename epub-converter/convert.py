#!/usr/bin/env python3
"""
Convert books to EPUB format from BLIB bundle files.

Reads chapter bodies from binslib/data/compressed/{book_id}.bundle (zstd),
metadata from binslib/data/binslib.db (SQLite), and cover images from
binslib/public/covers/.  Caches results in binslib/data/epub/ with
chapter-count-aware filenames: {book_id}_{chapter_count}.epub.

A cached EPUB is reused when the chapter count matches; conversion is
re-triggered only when new chapters appear in the bundle or --force is used.

Usage:
    python3 convert.py                          # convert all eligible books
    python3 convert.py --ids 100358 128390      # specific books only
    python3 convert.py --status completed       # only completed books
    python3 convert.py --list                   # list eligible books
    python3 convert.py --dry-run                # show what would be converted
    python3 convert.py --force                  # reconvert even if cached
    python3 convert.py --no-cache               # write to cache dir but ignore existing
"""

from __future__ import annotations

import argparse
import glob
import os
import sqlite3
from pathlib import Path

from epub_builder import (
    BundleReader,
    build_epub,
    load_metadata_from_db,
    validate_cover,
)
from rich.console import Console
from rich.panel import Panel
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)
from rich.table import Table

# ── Status mapping ───────────────────────────────────────────────────────────
# books.status column: 1=ongoing, 2=completed, 3=paused
STATUS_MAP = {
    1: "ongoing",
    2: "completed",
    3: "paused",
}
STATUS_NAMES = list(STATUS_MAP.values())
STATUS_REVERSE = {v: k for k, v in STATUS_MAP.items()}

# ── Paths ────────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
BINSLIB_DIR = REPO_ROOT / "binslib"

# Override via environment for Docker or non-standard layouts
COMPRESSED_DIR = Path(
    os.environ.get("COMPRESSED_DIR", str(BINSLIB_DIR / "data" / "compressed"))
)
DB_PATH = Path(
    os.environ.get("DATABASE_PATH", str(BINSLIB_DIR / "data" / "binslib.db"))
)
COVERS_DIR = Path(os.environ.get("COVERS_DIR", str(BINSLIB_DIR / "public" / "covers")))
EPUB_CACHE_DIR = Path(
    os.environ.get("EPUB_CACHE_DIR", str(BINSLIB_DIR / "data" / "epub"))
)
DICT_PATH = Path(
    os.environ.get("ZSTD_DICT_PATH", str(BINSLIB_DIR / "data" / "global.dict"))
)

console = Console()


# ── Book Discovery ───────────────────────────────────────────────────────────


def get_bundle_books() -> list[int]:
    """Scan compressed/ for .bundle files, return sorted book IDs."""
    ids: list[int] = []
    if not COMPRESSED_DIR.is_dir():
        return ids
    for f in COMPRESSED_DIR.iterdir():
        if f.suffix == ".bundle" and f.stem.isdigit():
            ids.append(int(f.stem))
    return sorted(ids)


def bundle_path_for(book_id: int) -> Path:
    return COMPRESSED_DIR / f"{book_id}.bundle"


# ── Cache helpers ────────────────────────────────────────────────────────────


def find_cached_epub(book_id: int) -> tuple[Path | None, int]:
    """Find an existing cached EPUB for a book.

    Returns (path, cached_chapter_count) or (None, 0) if not cached.
    """
    pattern = str(EPUB_CACHE_DIR / f"{book_id}_*.epub")
    matches = glob.glob(pattern)
    if not matches:
        return None, 0

    # Parse chapter count from filename: {book_id}_{count}.epub
    for m in matches:
        name = Path(m).stem  # e.g. "100358_2500"
        parts = name.split("_", 1)
        if len(parts) == 2 and parts[1].isdigit():
            return Path(m), int(parts[1])

    # Malformed cache file — treat as not cached
    return None, 0


def cache_path_for(book_id: int, chapter_count: int) -> Path:
    """Return the expected cache path for a book with the given chapter count."""
    return EPUB_CACHE_DIR / f"{book_id}_{chapter_count}.epub"


def clean_stale_cache(book_id: int, keep_count: int | None = None) -> None:
    """Remove cached EPUBs for a book, optionally keeping a specific chapter count."""
    pattern = str(EPUB_CACHE_DIR / f"{book_id}_*.epub")
    for m in glob.glob(pattern):
        if keep_count is not None:
            expected = str(cache_path_for(book_id, keep_count))
            if m == expected:
                continue
        try:
            os.remove(m)
        except OSError:
            pass


# ── Metadata from DB ─────────────────────────────────────────────────────────


def get_book_status(book_id: int) -> int:
    """Read book status from DB (1=ongoing, 2=completed, 3=paused)."""
    if not DB_PATH.exists():
        return 0
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=5)
        row = conn.execute(
            "SELECT status FROM books WHERE id = ?", (book_id,)
        ).fetchone()
        conn.close()
        return row[0] if row else 0
    except sqlite3.Error:
        return 0


def get_book_name(book_id: int) -> str:
    """Read book name from DB."""
    meta = load_metadata_from_db(DB_PATH, book_id)
    return meta.get("name", f"Book {book_id}") if meta else f"Book {book_id}"


# ── Main Conversion Logic ───────────────────────────────────────────────────


def convert_books(
    book_ids: list[int],
    force: bool = False,
):
    """Convert a list of books to EPUB with rich progress display."""
    EPUB_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    results: list[dict] = []

    dict_path = DICT_PATH if DICT_PATH.exists() else None

    # Outer progress: books
    books_progress = Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]{task.description}[/bold blue]"),
        BarColumn(bar_width=40),
        MofNCompleteColumn(),
        TextColumn("•"),
        TimeElapsedColumn(),
        TextColumn("•"),
        TimeRemainingColumn(),
    )

    # Inner progress: chapters within current book
    chapters_progress = Progress(
        TextColumn("  "),
        TextColumn("[cyan]{task.description}[/cyan]"),
        BarColumn(bar_width=30),
        MofNCompleteColumn(),
        TextColumn("•"),
        TimeElapsedColumn(),
    )

    from rich.console import Group
    from rich.live import Live

    group = Group(books_progress, chapters_progress)

    with Live(group, console=console, refresh_per_second=10):
        books_task = books_progress.add_task("Converting books", total=len(book_ids))

        for bid in book_ids:
            bp = bundle_path_for(bid)
            book_name = get_book_name(bid)
            reader = BundleReader(bp, dict_path=dict_path)
            num_chapters = reader.chapter_count

            books_progress.update(
                books_task,
                description=f"[{bid}] {book_name[:40]}",
            )

            # Skip books with no chapters
            if num_chapters == 0:
                results.append(
                    {
                        "book_id": bid,
                        "name": book_name,
                        "chapters": 0,
                        "status": "skipped",
                        "epub_path": None,
                        "error": "empty bundle",
                    }
                )
                books_progress.advance(books_task)
                continue

            # Cache check: skip if cached EPUB has same chapter count
            cached, cached_count = find_cached_epub(bid)
            if cached and cached_count >= num_chapters and not force:
                results.append(
                    {
                        "book_id": bid,
                        "name": book_name,
                        "chapters": num_chapters,
                        "status": "cached",
                        "epub_path": str(cached),
                        "error": None,
                    }
                )
                books_progress.advance(books_task)
                continue

            # Build EPUB
            epub_path = cache_path_for(bid, num_chapters)

            ch_task = chapters_progress.add_task(
                f"Chapters ({book_name[:30]})", total=num_chapters
            )

            def on_chapter(current, total):
                chapters_progress.update(ch_task, completed=current)

            try:
                result_path = build_epub(
                    book_id=bid,
                    bundle_path=bp,
                    db_path=DB_PATH,
                    covers_dir=COVERS_DIR,
                    dict_path=dict_path,
                    output_path=epub_path,
                    progress_callback=on_chapter,
                )

                # Remove stale cache entries for this book
                clean_stale_cache(bid, keep_count=num_chapters)

                results.append(
                    {
                        "book_id": bid,
                        "name": book_name,
                        "chapters": num_chapters,
                        "status": "done",
                        "epub_path": str(result_path),
                        "error": None,
                    }
                )
            except Exception as e:
                results.append(
                    {
                        "book_id": bid,
                        "name": book_name,
                        "chapters": num_chapters,
                        "status": "failed",
                        "epub_path": None,
                        "error": str(e)[:80],
                    }
                )

            chapters_progress.update(ch_task, visible=False)
            books_progress.advance(books_task)

    # Print summary
    done = [r for r in results if r["status"] == "done"]
    cached = [r for r in results if r["status"] == "cached"]
    failed = [r for r in results if r["status"] == "failed"]
    skipped = [r for r in results if r["status"] == "skipped"]

    console.print()
    summary = (
        f"[green]{len(done)}[/green] converted  •  "
        f"[blue]{len(cached)}[/blue] cached  •  "
        f"[red]{len(failed)}[/red] failed  •  "
        f"[dim]{len(skipped)}[/dim] skipped  •  "
        f"[bold]{len(results)}[/bold] total"
    )
    console.print(
        Panel(
            summary,
            title="[bold cyan]EPUB Conversion Summary[/bold cyan]",
            border_style="cyan",
        )
    )

    if failed:
        table = Table(title="Failed", show_header=True, header_style="bold red")
        table.add_column("ID", width=8, justify="right")
        table.add_column("Name", ratio=2)
        table.add_column("Error", ratio=3)
        for r in failed:
            table.add_row(str(r["book_id"]), r["name"][:40], r["error"])
        console.print(table)

    return results


# ── CLI ──────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Convert books from BLIB bundles to EPUB format.\n\n"
        "Reads chapters from binslib/data/compressed/*.bundle,\n"
        "metadata from binslib/data/binslib.db, and covers from\n"
        "binslib/public/covers/.  Caches results in binslib/data/epub/.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--ids",
        type=int,
        nargs="+",
        help="Specific book IDs to convert (default: all bundles)",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List eligible books and exit",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be converted without doing it",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Reconvert even if a cached EPUB exists",
    )
    parser.add_argument(
        "--status",
        choices=STATUS_NAMES,
        help="Only convert books with this status (ongoing, completed, paused)",
    )
    args = parser.parse_args()

    console.print(
        Panel("[bold]MTC EPUB Converter[/bold]", border_style="blue", expand=False)
    )

    # Validate paths
    if not COMPRESSED_DIR.is_dir():
        console.print(
            f"[red]Bundle directory not found:[/red] {COMPRESSED_DIR}\n"
            "Run book-ingest first to create bundle files."
        )
        return
    if not DB_PATH.exists():
        console.print(
            f"[red]Database not found:[/red] {DB_PATH}\n"
            "Run db:migrate and book-ingest first."
        )
        return

    all_ids = get_bundle_books()
    console.print(f"Bundles found:     [bold]{len(all_ids)}[/bold]")

    # Filter to requested IDs
    if args.ids:
        id_set = set(args.ids)
        target_ids = [bid for bid in all_ids if bid in id_set]
        missing = id_set - set(target_ids)
        # Also allow IDs not in all_ids if bundle exists
        for bid in sorted(missing):
            if bundle_path_for(bid).exists():
                target_ids.append(bid)
                missing.discard(bid)
        target_ids.sort()
        if missing:
            console.print(
                f"[yellow]WARNING: no bundles for IDs: {sorted(missing)}[/yellow]"
            )
    else:
        target_ids = all_ids

    # Collect info for each book
    eligible: list[dict] = []
    for bid in target_ids:
        bp = bundle_path_for(bid)
        reader = BundleReader(bp)
        ch_count = reader.chapter_count
        cached_path, cached_count = find_cached_epub(bid)
        book_status_num = get_book_status(bid)
        book_status = STATUS_MAP.get(book_status_num, "unknown")
        name = get_book_name(bid)
        has_cover = validate_cover(COVERS_DIR / f"{bid}.jpg")

        needs_conversion = ch_count > 0 and (
            not cached_path or cached_count < ch_count or args.force
        )

        eligible.append(
            {
                "id": bid,
                "name": name,
                "chapters": ch_count,
                "cached_path": cached_path,
                "cached_count": cached_count,
                "has_cover": has_cover,
                "book_status": book_status,
                "needs_conversion": needs_conversion,
            }
        )

    # Filter by --status
    if args.status:
        before = len(eligible)
        eligible = [e for e in eligible if e["book_status"] == args.status]
        console.print(
            f"Status filter:     [bold]{args.status}[/bold] "
            f"({len(eligible)}/{before} matched)"
        )

    to_convert = [e for e in eligible if e["needs_conversion"]]
    already_cached = [
        e for e in eligible if e["cached_path"] and not e["needs_conversion"]
    ]
    no_chapters = [e for e in eligible if e["chapters"] == 0]

    console.print(f"Targeted:          [bold]{len(eligible)}[/bold]")
    console.print(f"To convert:        [bold]{len(to_convert)}[/bold]")
    if already_cached:
        console.print(f"Already cached:    [dim]{len(already_cached)}[/dim]")
    if no_chapters:
        console.print(f"Empty bundles:     [dim]{len(no_chapters)}[/dim]")
    console.print(f"Cache dir:         [dim]{EPUB_CACHE_DIR}[/dim]")
    console.print()

    # --list mode
    if args.list:
        table = Table(title="Eligible Books", show_header=True, header_style="bold")
        table.add_column("ID", width=8, justify="right")
        table.add_column("Name", ratio=3)
        table.add_column("Chaps", width=7, justify="right")
        table.add_column("Status", width=10, justify="center")
        table.add_column("Cover", width=6, justify="center")
        table.add_column("Cached", width=8, justify="center")
        table.add_column("Action", width=10, justify="center")
        for e in sorted(eligible, key=lambda x: x["chapters"], reverse=True):
            st = e["book_status"]
            if st == "completed":
                status_fmt = "[green]completed[/green]"
            elif st == "ongoing":
                status_fmt = "[yellow]ongoing[/yellow]"
            elif st == "paused":
                status_fmt = "[red]paused[/red]"
            else:
                status_fmt = "[dim]unknown[/dim]"
            cover_icon = "[green]Y[/green]" if e["has_cover"] else "[red]N[/red]"
            if e["cached_path"]:
                cached_fmt = f"[green]{e['cached_count']}ch[/green]"
            else:
                cached_fmt = "[dim]-[/dim]"
            if e["needs_conversion"]:
                action_fmt = "[bold yellow]convert[/bold yellow]"
            elif e["chapters"] == 0:
                action_fmt = "[dim]skip[/dim]"
            else:
                action_fmt = "[green]ok[/green]"
            table.add_row(
                str(e["id"]),
                e["name"][:50],
                str(e["chapters"]),
                status_fmt,
                cover_icon,
                cached_fmt,
                action_fmt,
            )
        console.print(table)
        return

    # --dry-run mode
    if args.dry_run:
        console.print("[bold]Would convert:[/bold]")
        for e in to_convert:
            cover_s = "cover:Y" if e["has_cover"] else "[dim]cover:N[/dim]"
            cached_s = ""
            if e["cached_path"]:
                cached_s = (
                    f" [dim](cached {e['cached_count']}ch → {e['chapters']}ch)[/dim]"
                )
            console.print(
                f"  {e['id']:>7d}  {e['chapters']:>5d} chaps  "
                f"[{e['book_status']}]  {cover_s}{cached_s}  {e['name'][:50]}"
            )
        if not to_convert:
            console.print("  [dim](none)[/dim]")
        return

    if not to_convert:
        console.print(
            "[green]Nothing to convert. All books are cached with current chapter counts.[/green]"
        )
        return

    # Run conversion
    ids_to_convert = [e["id"] for e in to_convert]
    convert_books(ids_to_convert, force=args.force)


if __name__ == "__main__":
    main()
