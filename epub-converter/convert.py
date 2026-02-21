#!/usr/bin/env python3
"""
Convert crawled books to EPUB format.

Reads chapter .txt files, metadata.json, and cover.jpg from crawler/output/
and produces EPUB 3.0 files in epub-converter/epub-output/{book_id}/.
Non-txt source files (metadata.json, cover.jpg, book.json) are copied alongside.
If metadata.json is missing for a book, automatically invokes the meta-puller.

Usage:
    python3 convert.py                          # convert all eligible books
    python3 convert.py --ids 100358 128390      # specific books only
    python3 convert.py --status completed       # only completed books
    python3 convert.py --list                   # list eligible books
    python3 convert.py --dry-run                # show what would be converted
    python3 convert.py --force                  # reconvert even if .epub exists
    python3 convert.py --no-audit               # skip AUDIT.md update
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

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

from epub_builder import build_epub, discover_chapters, load_metadata, validate_cover

# ── Status mapping ───────────────────────────────────────────────────────────
# metadata.json "status" field: 1=ongoing, 2=completed, 3=paused
STATUS_MAP = {
    1: "ongoing",
    2: "completed",
    3: "paused",
}
STATUS_NAMES = list(STATUS_MAP.values())  # for argparse choices
STATUS_REVERSE = {v: k for k, v in STATUS_MAP.items()}

# ── Paths ────────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent

# Inside Docker, volumes are mounted at /data/*
# Outside Docker, resolve relative to repo root
if Path("/data/crawler").is_dir():
    CRAWLER_DIR = Path("/data/crawler")
    OUTPUT_DIR = CRAWLER_DIR / "output"
    AUDIT_PATH = CRAWLER_DIR / "AUDIT.md"
    META_PULLER = Path("/data/meta-puller/pull_metadata.py")
    EPUB_OUTPUT_DIR = Path("/data/epub-output")
else:
    REPO_ROOT = SCRIPT_DIR.parent
    CRAWLER_DIR = REPO_ROOT / "crawler"
    OUTPUT_DIR = CRAWLER_DIR / "output"
    AUDIT_PATH = CRAWLER_DIR / "AUDIT.md"
    META_PULLER = REPO_ROOT / "meta-puller" / "pull_metadata.py"
    EPUB_OUTPUT_DIR = SCRIPT_DIR

console = Console()


# ── Book Discovery ───────────────────────────────────────────────────────────

def get_book_dirs() -> list[Path]:
    """Find all book directories in the output folder."""
    dirs = []
    if not OUTPUT_DIR.is_dir():
        return dirs
    for entry in sorted(OUTPUT_DIR.iterdir()):
        if entry.is_dir() and entry.name.isdigit():
            dirs.append(entry)
    return dirs


def get_epub_output_dir(book_id: int) -> Path:
    """Return the epub-output directory for a book: epub-converter/epub-output/{book_id}/"""
    return EPUB_OUTPUT_DIR / "epub-output" / str(book_id)


def book_has_epub(book_dir: Path) -> Path | None:
    """Return the .epub path if one already exists in the epub-output dir, else None."""
    book_id = int(book_dir.name)
    out_dir = get_epub_output_dir(book_id)
    if not out_dir.is_dir():
        return None
    for f in out_dir.iterdir():
        if f.is_file() and f.suffix == ".epub":
            return f
    return None


def copy_non_txt_files(book_dir: Path, dest_dir: Path):
    """Copy all non-.txt files from book_dir to dest_dir."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    for f in book_dir.iterdir():
        if not f.is_file():
            continue
        if f.suffix == ".txt":
            continue
        if f.suffix == ".epub":
            continue
        dest_file = dest_dir / f.name
        shutil.copy2(f, dest_file)


def book_has_chapters(book_dir: Path) -> int:
    """Return the number of chapter .txt files."""
    return len(discover_chapters(book_dir))


def book_has_metadata(book_dir: Path) -> bool:
    """Check if metadata.json exists."""
    return (book_dir / "metadata.json").exists()


def book_has_cover(book_dir: Path) -> bool:
    """Check if cover.jpg exists and is valid."""
    return validate_cover(book_dir / "cover.jpg")


# ── Meta-puller Integration ──────────────────────────────────────────────────

def run_meta_puller(book_id: int) -> bool:
    """Invoke the meta-puller for a specific book ID.

    Returns True if metadata.json was created successfully.
    """
    if not META_PULLER.exists():
        console.print(
            f"  [yellow]WARNING[/yellow] meta-puller not found at {META_PULLER}"
        )
        return False

    try:
        env = os.environ.copy()
        env["PYTHONPATH"] = str(CRAWLER_DIR)

        result = subprocess.run(
            [sys.executable, str(META_PULLER), "--ids", str(book_id)],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=str(META_PULLER.parent),
            env=env,
        )
        if result.returncode == 0:
            return True
        console.print(f"  [red]meta-puller failed[/red]: {result.stderr.strip()}")
    except subprocess.TimeoutExpired:
        console.print(f"  [red]meta-puller timed out[/red] for book {book_id}")
    except Exception as e:
        console.print(f"  [red]meta-puller error[/red]: {e}")

    return False


# ── AUDIT.md Update ──────────────────────────────────────────────────────────

def update_audit(results: list[dict]):
    """Append or update the EPUB Conversion section in AUDIT.md.

    Each result dict has: book_id, name, chapters, status, epub_path, error
    """
    if not AUDIT_PATH.exists():
        console.print("[yellow]AUDIT.md not found, skipping audit update[/yellow]")
        return

    content = AUDIT_PATH.read_text(encoding="utf-8")

    # Build the new section
    section_lines = []
    section_lines.append("## EPUB Conversion")
    section_lines.append("")
    section_lines.append(
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    )
    section_lines.append("")

    done = [r for r in results if r["status"] == "done"]
    failed = [r for r in results if r["status"] == "failed"]
    skipped = [r for r in results if r["status"] == "skipped"]

    section_lines.append("| Status  | Count |")
    section_lines.append("| ------- | ----: |")
    section_lines.append(f"| Done    | {len(done):5d} |")
    section_lines.append(f"| Failed  | {len(failed):5d} |")
    section_lines.append(f"| Skipped | {len(skipped):5d} |")
    section_lines.append("")

    if done:
        section_lines.append("### Converted")
        section_lines.append("")
        section_lines.append("|     ID | Chapters | EPUB File | Name |")
        section_lines.append("| -----: | -------: | --------- | ---- |")
        for r in sorted(done, key=lambda x: x["chapters"], reverse=True):
            epub_name = Path(r["epub_path"]).name if r["epub_path"] else ""
            section_lines.append(
                f"| {r['book_id']:6d} | {r['chapters']:8d} | {epub_name} | {r['name']} |"
            )
        section_lines.append("")

    if failed:
        section_lines.append("### Failed")
        section_lines.append("")
        section_lines.append("|     ID | Error | Name |")
        section_lines.append("| -----: | ----- | ---- |")
        for r in sorted(failed, key=lambda x: x["book_id"]):
            section_lines.append(
                f"| {r['book_id']:6d} | {r['error']} | {r['name']} |"
            )
        section_lines.append("")

    new_section = "\n".join(section_lines)

    # Replace existing section or append
    marker = "## EPUB Conversion"
    if marker in content:
        # Find the section and replace it (up to the next ## or end of file)
        pattern = re.compile(
            r"## EPUB Conversion\n.*?(?=\n## (?!EPUB)|$)", re.DOTALL
        )
        content = pattern.sub(new_section, content)
    else:
        content = content.rstrip() + "\n\n" + new_section + "\n"

    AUDIT_PATH.write_text(content, encoding="utf-8")
    console.print(f"[green]AUDIT.md updated[/green] at {AUDIT_PATH}")


# ── Main Conversion Logic ───────────────────────────────────────────────────

def convert_books(
    book_dirs: list[Path],
    force: bool = False,
    skip_audit: bool = False,
):
    """Convert a list of book directories to EPUB with rich progress display."""

    results: list[dict] = []

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

    from rich.live import Live
    from rich.console import Group

    group = Group(books_progress, chapters_progress)

    with Live(group, console=console, refresh_per_second=10):
        books_task = books_progress.add_task(
            "Converting books", total=len(book_dirs)
        )

        for book_dir in book_dirs:
            book_id = int(book_dir.name)
            meta = load_metadata(book_dir)
            book_name = meta.get("name", f"Book {book_id}")
            num_chapters = book_has_chapters(book_dir)

            books_progress.update(
                books_task,
                description=f"[{book_id}] {book_name[:40]}",
            )

            # Skip books with no chapters
            if num_chapters == 0:
                results.append({
                    "book_id": book_id,
                    "name": book_name,
                    "chapters": 0,
                    "status": "skipped",
                    "epub_path": None,
                    "error": "no chapters",
                })
                books_progress.advance(books_task)
                continue

            # Skip if EPUB already exists (unless --force)
            existing = book_has_epub(book_dir)
            if existing and not force:
                results.append({
                    "book_id": book_id,
                    "name": book_name,
                    "chapters": num_chapters,
                    "status": "done",
                    "epub_path": str(existing),
                    "error": None,
                })
                books_progress.advance(books_task)
                continue

            # Ensure metadata exists (invoke meta-puller if missing)
            if not book_has_metadata(book_dir):
                console.print(
                    f"  [yellow]Pulling metadata for {book_id}...[/yellow]"
                )
                run_meta_puller(book_id)
                # Reload metadata after pulling
                meta = load_metadata(book_dir)
                book_name = meta.get("name", f"Book {book_id}")

            # Prepare epub-output directory
            epub_out = get_epub_output_dir(book_id)
            epub_out.mkdir(parents=True, exist_ok=True)

            # Determine EPUB file path
            safe_name = re.sub(r'[<>:"/\\|?*]', "", book_name).strip()
            if not safe_name:
                safe_name = f"book_{book_id}"
            epub_file = epub_out / f"{safe_name}.epub"

            # Chapter-level progress
            ch_task = chapters_progress.add_task(
                f"Chapters ({book_name[:30]})", total=num_chapters
            )

            def on_chapter(current, total):
                chapters_progress.update(ch_task, completed=current)

            try:
                epub_path = build_epub(
                    book_dir,
                    output_path=epub_file,
                    progress_callback=on_chapter,
                )
                # Copy non-txt files (metadata.json, cover.jpg, book.json, etc.)
                copy_non_txt_files(book_dir, epub_out)

                results.append({
                    "book_id": book_id,
                    "name": book_name,
                    "chapters": num_chapters,
                    "status": "done",
                    "epub_path": str(epub_path),
                    "error": None,
                })
            except Exception as e:
                results.append({
                    "book_id": book_id,
                    "name": book_name,
                    "chapters": num_chapters,
                    "status": "failed",
                    "epub_path": None,
                    "error": str(e)[:80],
                })

            chapters_progress.update(ch_task, visible=False)
            books_progress.advance(books_task)

    # Print summary
    done = [r for r in results if r["status"] == "done"]
    failed = [r for r in results if r["status"] == "failed"]
    skipped = [r for r in results if r["status"] == "skipped"]

    console.print()
    summary = (
        f"[green]{len(done)}[/green] converted  •  "
        f"[red]{len(failed)}[/red] failed  •  "
        f"[dim]{len(skipped)}[/dim] skipped  •  "
        f"[bold]{len(results)}[/bold] total"
    )
    console.print(
        Panel(summary, title="[bold cyan]EPUB Conversion Summary[/bold cyan]",
              border_style="cyan")
    )

    if failed:
        table = Table(title="Failed", show_header=True, header_style="bold red")
        table.add_column("ID", width=8, justify="right")
        table.add_column("Name", ratio=2)
        table.add_column("Error", ratio=3)
        for r in failed:
            table.add_row(str(r["book_id"]), r["name"][:40], r["error"])
        console.print(table)

    # Update AUDIT.md
    if not skip_audit and results:
        update_audit(results)

    return results


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Convert crawled books to EPUB format"
    )
    parser.add_argument(
        "--ids", type=int, nargs="+",
        help="Specific book IDs to convert (default: all)",
    )
    parser.add_argument(
        "--list", action="store_true",
        help="List eligible books and exit",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Show what would be converted without doing it",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Reconvert even if .epub already exists",
    )
    parser.add_argument(
        "--status", choices=STATUS_NAMES,
        help="Only convert books with this status (ongoing, completed, paused)",
    )
    parser.add_argument(
        "--no-audit", action="store_true",
        help="Skip updating AUDIT.md",
    )
    args = parser.parse_args()

    console.print(
        Panel("[bold]MTC EPUB Converter[/bold]", border_style="blue", expand=False)
    )

    all_dirs = get_book_dirs()
    console.print(f"Books in output/:  [bold]{len(all_dirs)}[/bold]")

    # Filter to requested IDs
    if args.ids:
        id_set = set(args.ids)
        target_dirs = [d for d in all_dirs if int(d.name) in id_set]
        missing = id_set - {int(d.name) for d in target_dirs}
        if missing:
            console.print(
                f"[yellow]WARNING: book IDs not in output/: {sorted(missing)}[/yellow]"
            )
    else:
        target_dirs = all_dirs

    # Collect info for display
    eligible = []
    for d in target_dirs:
        ch_count = book_has_chapters(d)
        has_epub = book_has_epub(d)
        has_meta = book_has_metadata(d)
        has_cov = book_has_cover(d)
        meta = load_metadata(d)
        name = meta.get("name", f"Book {d.name}")
        book_status = STATUS_MAP.get(meta.get("status"), "unknown")
        eligible.append({
            "dir": d,
            "id": int(d.name),
            "name": name,
            "chapters": ch_count,
            "has_epub": has_epub,
            "has_meta": has_meta,
            "has_cover": has_cov,
            "book_status": book_status,
        })

    # Filter by --status if provided
    if args.status:
        before = len(eligible)
        eligible = [e for e in eligible if e["book_status"] == args.status]
        console.print(f"Status filter:     [bold]{args.status}[/bold] ({len(eligible)}/{before} matched)")

    # Filter: need chapters, and either --force or no existing EPUB
    if not args.force:
        to_convert = [e for e in eligible if e["chapters"] > 0 and not e["has_epub"]]
    else:
        to_convert = [e for e in eligible if e["chapters"] > 0]

    console.print(f"Targeted:          [bold]{len(eligible)}[/bold]")
    console.print(f"To convert:        [bold]{len(to_convert)}[/bold]")
    already = len([e for e in eligible if e["has_epub"]])
    if already and not args.force:
        console.print(f"Already converted: [dim]{already}[/dim]")
    no_chapters = len([e for e in eligible if e["chapters"] == 0])
    if no_chapters:
        console.print(f"No chapters:       [dim]{no_chapters}[/dim]")
    console.print()

    # --list mode
    if args.list:
        table = Table(title="Eligible Books", show_header=True, header_style="bold")
        table.add_column("ID", width=8, justify="right")
        table.add_column("Name", ratio=3)
        table.add_column("Chaps", width=7, justify="right")
        table.add_column("Status", width=10, justify="center")
        table.add_column("Meta", width=5, justify="center")
        table.add_column("Cover", width=6, justify="center")
        table.add_column("EPUB", width=5, justify="center")
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
            meta_icon = "[green]Y[/green]" if e["has_meta"] else "[red]N[/red]"
            cover_icon = "[green]Y[/green]" if e["has_cover"] else "[red]N[/red]"
            epub_icon = "[green]Y[/green]" if e["has_epub"] else "[dim]-[/dim]"
            table.add_row(
                str(e["id"]), e["name"][:50], str(e["chapters"]),
                status_fmt, meta_icon, cover_icon, epub_icon,
            )
        console.print(table)
        return

    # --dry-run mode
    if args.dry_run:
        console.print("[bold]Would convert:[/bold]")
        for e in to_convert:
            meta_s = "meta:Y" if e["has_meta"] else "[yellow]meta:N (will pull)[/yellow]"
            cover_s = "cover:Y" if e["has_cover"] else "[dim]cover:N[/dim]"
            st = e["book_status"]
            console.print(
                f"  {e['id']:>7d}  {e['chapters']:>5d} chaps  [{st}]  {meta_s}  {cover_s}  {e['name'][:50]}"
            )
        return

    if not to_convert:
        console.print("[green]Nothing to convert. All books already have EPUBs.[/green]")
        return

    # Run conversion
    dirs_to_convert = [e["dir"] for e in to_convert]
    convert_books(dirs_to_convert, force=args.force, skip_audit=args.no_audit)


if __name__ == "__main__":
    main()
