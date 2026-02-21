#!/usr/bin/env python3
"""
Audit report: compare API chapter counts vs saved chapters on disk.

For each book in crawler/output/, fetches the current chapter_count
from the API and compares against what's been saved locally.

Usage:
    python3 audit.py                    # full audit, print to terminal
    python3 audit.py --save             # also save AUDIT.md report
    python3 audit.py --save --out report.md
    python3 audit.py --no-api           # skip API calls, only check disk
    python3 audit.py --bookmarks        # also include bookmarked-but-not-started books from device DB
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import httpx

# Resolve paths relative to this script
SCRIPT_DIR = Path(__file__).resolve().parent
CRAWLER_DIR = SCRIPT_DIR.parent
DEFAULT_OUTPUT_DIR = CRAWLER_DIR / "output"

sys.path.insert(0, str(CRAWLER_DIR))
from config import BASE_URL, HEADERS, REQUEST_DELAY

ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
DEVICE = "emulator-5554"
PACKAGES = {
    "debug": "com.novelfever.app.android.debug",
    "debug2": "com.novelfever.app.android.debug2",
}


# ── Data ──────────────────────────────────────────────────────────────────────

@dataclass
class BookAudit:
    book_id: int
    name: str
    api_chapters: int      # chapter_count from API (0 if not fetched)
    saved_chapters: int    # chapters_saved from book.json
    total_in_db: int       # total_in_db from book.json
    txt_files: int         # actual .txt chapter files on disk
    disk_bytes: int
    has_folder: bool
    api_fetched: bool      # whether API was successfully queried

    @property
    def target(self) -> int:
        """Best-known total chapter count."""
        if self.api_fetched and self.api_chapters > 0:
            return self.api_chapters
        if self.total_in_db > 0:
            return self.total_in_db
        return 0

    @property
    def status(self) -> str:
        if not self.has_folder:
            return "not_started"
        if self.txt_files == 0 and self.saved_chapters == 0:
            return "empty"
        if self.target > 0 and self.saved_chapters >= self.target:
            return "done"
        if self.saved_chapters > 0 and self.target == 0:
            return "done"  # no known target, assume complete
        if self.saved_chapters > 0:
            return "partial"
        return "empty"

    @property
    def pct(self) -> float:
        if self.target <= 0:
            return 100.0 if self.saved_chapters > 0 else 0.0
        return self.saved_chapters * 100.0 / self.target

    @property
    def missing(self) -> int:
        return max(0, self.target - self.saved_chapters)


# ── Disk Scanner ──────────────────────────────────────────────────────────────

def scan_disk(output_dir: Path) -> dict[int, BookAudit]:
    """Scan output folders and build BookAudit entries from disk data."""
    books: dict[int, BookAudit] = {}

    if not output_dir.is_dir():
        return books

    for entry in sorted(output_dir.iterdir()):
        if not entry.is_dir():
            continue
        try:
            book_id = int(entry.name)
        except ValueError:
            continue

        name = f"Book {book_id}"
        chapters_saved = 0
        total_in_db = 0
        json_path = entry / "book.json"
        if json_path.exists():
            try:
                with open(json_path) as f:
                    meta = json.load(f)
                name = meta.get("book_name", name)
                chapters_saved = meta.get("chapters_saved", 0)
                total_in_db = meta.get("total_in_db", 0)
            except (json.JSONDecodeError, OSError):
                pass

        # Also check metadata.json for richer info
        meta_path = entry / "metadata.json"
        if meta_path.exists():
            try:
                with open(meta_path) as f:
                    full_meta = json.load(f)
                name = full_meta.get("name", name)
            except (json.JSONDecodeError, OSError):
                pass

        txt_files = 0
        disk_bytes = 0
        for f in entry.iterdir():
            if f.is_file():
                disk_bytes += f.stat().st_size
                if f.suffix == ".txt" and f.name[0].isdigit() and "_" in f.name:
                    txt_files += 1

        books[book_id] = BookAudit(
            book_id=book_id,
            name=name,
            api_chapters=0,
            saved_chapters=chapters_saved,
            total_in_db=total_in_db,
            txt_files=txt_files,
            disk_bytes=disk_bytes,
            has_folder=True,
            api_fetched=False,
        )

    return books


# ── API Fetcher ───────────────────────────────────────────────────────────────

def fetch_book_info(book_id: int, client: httpx.Client) -> dict | None:
    """Fetch book info from API by ID."""
    try:
        r = client.get(
            f"{BASE_URL}/api/books/{book_id}",
            params={"include": "author,creator,genres"},
        )
        if r.status_code == 200:
            data = r.json()
            if data.get("success") and data.get("data"):
                return data["data"]
    except Exception:
        pass
    return None


def enrich_from_api(books: dict[int, BookAudit], book_ids: list[int]) -> int:
    """Fetch chapter counts from API for given book IDs. Returns count fetched."""
    fetched = 0
    total = len(book_ids)

    with httpx.Client(headers=HEADERS, timeout=30) as client:
        for i, bid in enumerate(book_ids):
            info = fetch_book_info(bid, client)
            if info:
                chapter_count = info.get("chapter_count", 0) or info.get("latest_index", 0)
                name = info.get("name", "")

                if bid in books:
                    books[bid].api_chapters = chapter_count
                    books[bid].api_fetched = True
                    if name:
                        books[bid].name = name
                else:
                    books[bid] = BookAudit(
                        book_id=bid,
                        name=name or f"Book {bid}",
                        api_chapters=chapter_count,
                        saved_chapters=0,
                        total_in_db=0,
                        txt_files=0,
                        disk_bytes=0,
                        has_folder=False,
                        api_fetched=True,
                    )
                fetched += 1

            # Progress
            if (i + 1) % 10 == 0 or i + 1 == total:
                print(f"  API: {i + 1}/{total} fetched ({fetched} OK)")

            time.sleep(REQUEST_DELAY)

    return fetched


# ── Device DB (bookmarks) ────────────────────────────────────────────────────

def get_bookmarked_ids() -> list[dict]:
    """Pull bookmarked books from device DB. Returns list of {id, name, latest_index}."""
    results = []
    for app, package in PACKAGES.items():
        suffix = "2" if app == "debug2" else ""
        db_path = f"/tmp/mtc_audit{suffix}.db"
        try:
            data = subprocess.run(
                [ADB, "-s", DEVICE, "shell",
                 f"run-as {package} cat databases/app_database.db"],
                capture_output=True, timeout=5,
            ).stdout
            if len(data) < 100:
                continue
            with open(db_path, "wb") as f:
                f.write(data)
            conn = sqlite3.connect(db_path)
            rows = conn.execute("""
                SELECT id, name, latestIndex
                FROM BaseBook
                WHERE following = 1
                ORDER BY bookmarkId DESC
            """).fetchall()
            conn.close()
            for r in rows:
                results.append({"id": r[0], "name": r[1] or f"Book {r[0]}", "latest_index": r[2] or 0})
        except Exception:
            continue

    # Dedup by ID
    seen = set()
    deduped = []
    for b in results:
        if b["id"] not in seen:
            seen.add(b["id"])
            deduped.append(b)
    return deduped


# ── Report Generation ─────────────────────────────────────────────────────────

def format_bytes(n: int) -> str:
    if n < 1024:
        return f"{n}B"
    elif n < 1024 * 1024:
        return f"{n / 1024:.1f}KB"
    elif n < 1024 * 1024 * 1024:
        return f"{n / (1024*1024):.1f}MB"
    return f"{n / (1024*1024*1024):.1f}GB"


def generate_report(books: dict[int, BookAudit]) -> str:
    """Generate a markdown audit report."""
    all_books = sorted(books.values(), key=lambda b: b.book_id)

    done = [b for b in all_books if b.status == "done"]
    partial = [b for b in all_books if b.status == "partial"]
    empty = [b for b in all_books if b.status == "empty"]
    not_started = [b for b in all_books if b.status == "not_started"]

    done.sort(key=lambda b: b.saved_chapters, reverse=True)
    partial.sort(key=lambda b: b.pct, reverse=True)
    not_started.sort(key=lambda b: b.name)

    total_saved = sum(b.saved_chapters for b in all_books)
    total_api = sum(b.api_chapters for b in all_books if b.api_fetched)
    total_bytes = sum(b.disk_bytes for b in all_books if b.has_folder)

    lines = []
    lines.append("# Book Download Audit")
    lines.append("")
    lines.append(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")

    # Summary
    lines.append("## Summary")
    lines.append("")
    lines.append("| Status               |   Books | Chapters saved |")
    lines.append("| -------------------- | ------: | -------------: |")
    lines.append(f"| Done                 | {len(done):7d} | {sum(b.saved_chapters for b in done):14,d} |")
    lines.append(f"| Partial              | {len(partial):7d} | {sum(b.saved_chapters for b in partial):14,d} |")
    lines.append(f"| Empty folder         | {len(empty):7d} | {0:14,d} |")
    lines.append(f"| Not started          | {len(not_started):7d} | {0:14,d} |")
    lines.append(f"| **Total bookmarked** | **{len(all_books)}** | **{total_saved:,}** |")
    lines.append("")

    folders_on_disk = sum(1 for b in all_books if b.has_folder)
    lines.append(f"Output: {folders_on_disk} folders, {total_saved:,} chapters saved, {format_bytes(total_bytes)} on disk.")
    lines.append("")

    # Done
    if done:
        lines.append(f"## Done ({len(done)})")
        lines.append("")
        lines.append("|     ID | API Chaps | Saved | Name |")
        lines.append("| -----: | --------: | ----: | ---- |")
        for b in done:
            api_col = str(b.api_chapters) if b.api_fetched else "--"
            lines.append(f"| {b.book_id:6d} | {api_col:>9s} | {b.saved_chapters:5d} | {b.name} |")
        lines.append("")

    # Partial
    if partial:
        lines.append(f"## Partial ({len(partial)})")
        lines.append("")
        lines.append("|     ID | API Chaps | Saved |     % | Missing | Name |")
        lines.append("| -----: | --------: | ----: | ----: | ------: | ---- |")
        for b in partial:
            api_col = str(b.api_chapters) if b.api_fetched else str(b.total_in_db) + "*"
            lines.append(
                f"| {b.book_id:6d} | {api_col:>9s} | {b.saved_chapters:5d} "
                f"| {b.pct:5.1f}% | {b.missing:7d} | {b.name} |"
            )
        lines.append("")

    # Empty
    if empty:
        lines.append(f"## Empty Folder ({len(empty)})")
        lines.append("")
        lines.append("|     ID | API Chaps | Name |")
        lines.append("| -----: | --------: | ---- |")
        for b in empty:
            api_col = str(b.api_chapters) if b.api_fetched else "--"
            lines.append(f"| {b.book_id:6d} | {api_col:>9s} | {b.name} |")
        lines.append("")

    # Not started
    if not_started:
        lines.append(f"## Not Started ({len(not_started)})")
        lines.append("")
        lines.append("|     ID | API Chaps | Name |")
        lines.append("| -----: | --------: | ---- |")
        for b in not_started:
            api_col = str(b.api_chapters) if b.api_fetched else "--"
            lines.append(f"| {b.book_id:6d} | {api_col:>9s} | {b.name} |")
        lines.append("")

    return "\n".join(lines)


def print_summary(books: dict[int, BookAudit]):
    """Print a colored summary to terminal."""
    all_books = sorted(books.values(), key=lambda b: b.book_id)

    done = [b for b in all_books if b.status == "done"]
    partial = [b for b in all_books if b.status == "partial"]
    empty = [b for b in all_books if b.status == "empty"]
    not_started = [b for b in all_books if b.status == "not_started"]

    total_saved = sum(b.saved_chapters for b in all_books)
    total_bytes = sum(b.disk_bytes for b in all_books if b.has_folder)

    try:
        from rich.console import Console
        from rich.table import Table
        from rich.panel import Panel
        from rich.text import Text

        console = Console()

        # Summary panel
        summary = (
            f"[green]{len(done)}[/green] done  •  "
            f"[yellow]{len(partial)}[/yellow] partial  •  "
            f"[dim]{len(empty)}[/dim] empty  •  "
            f"[dim]{len(not_started)}[/dim] not started  •  "
            f"[bold]{len(all_books)}[/bold] total\n"
            f"Chapters saved: [bold]{total_saved:,}[/bold]  •  "
            f"Disk: [bold]{format_bytes(total_bytes)}[/bold]"
        )
        console.print(Panel(summary, title="[bold cyan]Audit Summary[/bold cyan]", border_style="cyan"))

        # Partial books (most interesting)
        if partial:
            partial_sorted = sorted(partial, key=lambda b: b.pct, reverse=True)
            table = Table(title=f"Partial ({len(partial)})", show_header=True,
                          header_style="bold", expand=True)
            table.add_column("ID", width=7, justify="right")
            table.add_column("Book", ratio=3)
            table.add_column("API", width=7, justify="right")
            table.add_column("Saved", width=7, justify="right")
            table.add_column("%", width=7, justify="right")
            table.add_column("Missing", width=8, justify="right")

            for b in partial_sorted:
                pct = b.pct
                if pct >= 95:
                    style = "green"
                elif pct >= 50:
                    style = "yellow"
                else:
                    style = "red"
                api_col = str(b.api_chapters) if b.api_fetched else f"{b.total_in_db}*"
                name_short = b.name[:45] + "…" if len(b.name) > 45 else b.name
                table.add_row(
                    str(b.book_id), name_short, api_col,
                    str(b.saved_chapters), f"[{style}]{pct:.1f}%[/{style}]",
                    str(b.missing),
                )
            console.print(table)

        # Done count
        if done:
            console.print(f"\n[green]✓[/green] {len(done)} books fully saved")

        # Empty
        if empty:
            console.print(f"[dim]  {len(empty)} empty folders[/dim]")

        # Not started
        if not_started:
            console.print(f"[dim]  {len(not_started)} bookmarked but not started[/dim]")

    except ImportError:
        # Fallback to plain text
        print(f"\nAudit Summary:")
        print(f"  Done: {len(done)}, Partial: {len(partial)}, "
              f"Empty: {len(empty)}, Not started: {len(not_started)}")
        print(f"  Total: {len(all_books)} books, {total_saved:,} chapters, "
              f"{format_bytes(total_bytes)}")
        if partial:
            print(f"\nPartial books:")
            for b in sorted(partial, key=lambda b: b.pct, reverse=True):
                api_col = b.api_chapters if b.api_fetched else b.total_in_db
                print(f"  {b.book_id:>7d}  {b.saved_chapters:>5d}/{api_col:<5d} "
                      f"({b.pct:5.1f}%)  {b.name[:50]}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Audit book downloads vs API chapter counts")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR),
                        help="Path to crawler output directory")
    parser.add_argument("--no-api", action="store_true",
                        help="Skip API calls, only check disk data")
    parser.add_argument("--bookmarks", action="store_true",
                        help="Include bookmarked books from device DB (requires emulator)")
    parser.add_argument("--save", action="store_true",
                        help="Save audit report to markdown file")
    parser.add_argument("--out", default=str(CRAWLER_DIR / "AUDIT.md"),
                        help="Output path for markdown report (default: crawler/AUDIT.md)")
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    print(f"Scanning: {output_dir}")

    # 1. Scan disk
    books = scan_disk(output_dir)
    print(f"  Found {len(books)} book folders on disk")

    # 2. Get bookmarks from device DB
    if args.bookmarks:
        print("\nFetching bookmarks from device...")
        bookmarks = get_bookmarked_ids()
        print(f"  Found {len(bookmarks)} bookmarked books")
        for bm in bookmarks:
            bid = bm["id"]
            if bid not in books:
                books[bid] = BookAudit(
                    book_id=bid,
                    name=bm["name"],
                    api_chapters=0,
                    saved_chapters=0,
                    total_in_db=0,
                    txt_files=0,
                    disk_bytes=0,
                    has_folder=False,
                    api_fetched=False,
                )
            # Use bookmark's latest_index as a fallback target
            if bm["latest_index"] > 0 and not books[bid].api_fetched:
                books[bid].api_chapters = bm["latest_index"]

    # 3. Fetch from API
    if not args.no_api:
        all_ids = sorted(books.keys())
        print(f"\nFetching chapter counts from API for {len(all_ids)} books...")
        fetched = enrich_from_api(books, all_ids)
        print(f"  Fetched {fetched}/{len(all_ids)} from API")

    # 4. Print summary
    print()
    print_summary(books)

    # 5. Save report
    if args.save:
        report = generate_report(books)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(report)
        print(f"\nReport saved to: {args.out}")


if __name__ == "__main__":
    main()
