#!/usr/bin/env python3
"""
Real-time crawling progress dashboard.

Polls the emulator's SQLite DBs (both app instances) and crawler/output/
to display a live terminal dashboard showing download and extraction status.

Usage:
    python dashboard.py                      # default: 5s interval, both apps
    python dashboard.py --interval 3         # poll every 3 seconds
    python dashboard.py --no-device          # skip DB polling, output-only mode
    python dashboard.py --single             # only monitor App 1
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import termios
import time
import tty
from dataclasses import dataclass, field
from pathlib import Path
from threading import Thread

from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

# ── Constants ─────────────────────────────────────────────────────────────────

ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
DEVICE = "emulator-5554"

PACKAGES = {
    "debug": "com.novelfever.app.android.debug",
    "debug2": "com.novelfever.app.android.debug2",
}

TEMP_DB_PATHS = {
    "debug": "/tmp/mtc_progress.db",
    "debug2": "/tmp/mtc_progress2.db",
}

DEFAULT_OUTPUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "crawler", "output"
)


# ── Data structures ───────────────────────────────────────────────────────────

@dataclass
class BookInDB:
    book_id: int
    name: str
    latest_index: int
    chapter_count: int  # chapters currently in DB
    app: str  # "debug" or "debug2"


@dataclass
class BookOnDisk:
    book_id: int
    name: str
    chapters_saved: int  # from book.json
    total_in_db: int  # from book.json
    txt_files: int  # actual .txt chapter files on disk
    has_combined: bool  # combined book .txt exists
    disk_bytes: int  # total size of all files in the dir
    mtime: float = 0.0  # modification time of the directory (for recency)


@dataclass
class ActiveDownload:
    book_id: int
    name: str
    app: str
    current: int
    target: int
    rate: float  # chapters per second (smoothed)
    eta_seconds: float  # estimated time remaining


@dataclass
class Snapshot:
    """A single poll snapshot of all data."""
    timestamp: float = 0.0
    db_books: dict[str, list[BookInDB]] = field(default_factory=dict)
    db_chapter_counts: dict[str, dict[int, int]] = field(default_factory=dict)
    disk_books: list[BookOnDisk] = field(default_factory=list)
    db_accessible: dict[str, bool] = field(default_factory=dict)
    db_errors: dict[str, str] = field(default_factory=dict)


# View modes: how many items to show in the extraction list
VIEW_COLLAPSED = 3
VIEW_EXPANDED = 10
VIEW_FULL = -1  # sentinel: show all

SORT_OPTIONS = ["recent", "name", "size", "chapters", "id"]
SORT_LABELS = {
    "recent": "Recent",
    "name": "Name",
    "size": "Size",
    "chapters": "Chapters",
    "id": "ID",
}


@dataclass
class ListState:
    """UI state for the extraction list panel."""
    view_size: int = VIEW_COLLAPSED  # 3, 10, or -1 (full)
    page: int = 0  # 0-based page index
    sort_key: str = "recent"  # one of SORT_OPTIONS
    sort_reverse: bool = True  # descending by default
    search_query: str = ""  # active filter text
    search_mode: bool = False  # True when typing into search box
    search_buf: str = ""  # in-progress search text

    def cycle_view(self):
        if self.view_size == VIEW_COLLAPSED:
            self.view_size = VIEW_EXPANDED
        elif self.view_size == VIEW_EXPANDED:
            self.view_size = VIEW_FULL
        else:
            self.view_size = VIEW_COLLAPSED
        self.page = 0

    def cycle_sort(self):
        idx = SORT_OPTIONS.index(self.sort_key)
        self.sort_key = SORT_OPTIONS[(idx + 1) % len(SORT_OPTIONS)]
        self.page = 0

    def page_count(self, total: int) -> int:
        if self.view_size == VIEW_FULL or self.view_size <= 0:
            return 1
        return max(1, (total + self.view_size - 1) // self.view_size)

    def next_page(self, total: int):
        mx = self.page_count(total) - 1
        if self.page < mx:
            self.page += 1

    def prev_page(self, total: int):
        if self.page > 0:
            self.page -= 1

    def enter_search(self):
        self.search_mode = True
        self.search_buf = self.search_query

    def apply_search(self):
        self.search_query = self.search_buf.strip()
        self.search_mode = False
        self.page = 0

    def cancel_search(self):
        self.search_mode = False
        self.search_buf = self.search_query

    def clear_search(self):
        self.search_query = ""
        self.search_buf = ""
        self.search_mode = False
        self.page = 0


# ── DB Polling ────────────────────────────────────────────────────────────────

def pull_db(app: str) -> str | None:
    """Pull the app's SQLite DB from device to a local temp file.

    Uses a unique temp path to avoid conflicts with grab_book.py.
    Returns the local path or None on failure.
    """
    package = PACKAGES[app]
    db_path = TEMP_DB_PATHS[app]

    try:
        result = subprocess.run(
            [ADB, "-s", DEVICE, "shell",
             f"run-as {package} cat databases/app_database.db"],
            capture_output=True, timeout=5,
        )
        if result.returncode != 0 or len(result.stdout) < 100:
            return None
        with open(db_path, "wb") as f:
            f.write(result.stdout)
        return db_path
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


def query_db(app: str) -> tuple[list[BookInDB], dict[int, int]] | None:
    """Pull DB and query books + chapter counts.

    Returns (books_list, {book_id: chapter_count}) or None on failure.
    """
    db_path = pull_db(app)
    if not db_path:
        return None

    try:
        conn = sqlite3.connect(db_path)

        # Get bookmarked books
        books = []
        try:
            rows = conn.execute("""
                SELECT id, name, latestIndex
                FROM BaseBook
                WHERE following = 1
                ORDER BY bookmarkId DESC
            """).fetchall()
            for r in rows:
                books.append(BookInDB(
                    book_id=r[0],
                    name=r[1] or f"Book {r[0]}",
                    latest_index=r[2] or 0,
                    chapter_count=0,
                    app=app,
                ))
        except sqlite3.OperationalError:
            pass

        # Get chapter counts per book
        counts: dict[int, int] = {}
        try:
            rows = conn.execute("""
                SELECT bookId, COUNT(*) FROM Chapter GROUP BY bookId
            """).fetchall()
            for r in rows:
                counts[r[0]] = r[1]
        except sqlite3.OperationalError:
            pass

        # Fill in chapter_count on books
        for b in books:
            b.chapter_count = counts.get(b.book_id, 0)

        conn.close()
        return books, counts

    except (sqlite3.DatabaseError, OSError):
        return None


# ── Output Directory Scanner ──────────────────────────────────────────────────

def scan_output_dir(output_dir: str) -> list[BookOnDisk]:
    """Scan crawler/output/ for extracted books."""
    books = []
    output_path = Path(output_dir)

    if not output_path.is_dir():
        return books

    for entry in sorted(output_path.iterdir()):
        if not entry.is_dir():
            continue
        try:
            book_id = int(entry.name)
        except ValueError:
            continue

        # Read book.json if present
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

        # Count actual chapter .txt files (pattern: NNNN_slug.txt)
        txt_files = 0
        has_combined = False
        disk_bytes = 0
        latest_mtime = entry.stat().st_mtime

        for f in entry.iterdir():
            if f.is_file():
                st = f.stat()
                disk_bytes += st.st_size
                latest_mtime = max(latest_mtime, st.st_mtime)
                if f.suffix == ".txt":
                    if f.name[0].isdigit() and "_" in f.name:
                        txt_files += 1
                    elif f.name != "book.json":
                        has_combined = True

        books.append(BookOnDisk(
            book_id=book_id,
            name=name,
            chapters_saved=chapters_saved,
            total_in_db=total_in_db,
            txt_files=txt_files,
            has_combined=has_combined,
            disk_bytes=disk_bytes,
            mtime=latest_mtime,
        ))

    return books


# ── Change Detection & Rate Calculation ───────────────────────────────────────

class ChangeTracker:
    """Tracks chapter count changes across polls to detect active downloads."""

    def __init__(self):
        # {(app, book_id): [(timestamp, count), ...]}
        self.history: dict[tuple[str, int], list[tuple[float, int]]] = {}
        self.max_history = 30  # keep last N data points

    def update(self, app: str, book_id: int, count: int, ts: float):
        key = (app, book_id)
        if key not in self.history:
            self.history[key] = []
        hist = self.history[key]

        # Only append if count changed or it's the first entry
        if not hist or hist[-1][1] != count:
            hist.append((ts, count))
        elif hist:
            # Update timestamp even if count unchanged (for stall detection)
            hist.append((ts, count))

        # Trim history
        if len(hist) > self.max_history:
            self.history[key] = hist[-self.max_history:]

    def get_rate(self, app: str, book_id: int) -> float:
        """Compute chapters/second over recent history window."""
        key = (app, book_id)
        hist = self.history.get(key, [])
        if len(hist) < 2:
            return 0.0

        # Use a window of last ~60 seconds for rate calculation
        now_ts = hist[-1][0]
        window_start = now_ts - 60

        # Find earliest point in window
        for i, (ts, _) in enumerate(hist):
            if ts >= window_start:
                start_ts, start_count = hist[i][0], hist[i][1]
                end_ts, end_count = hist[-1][0], hist[-1][1]
                dt = end_ts - start_ts
                if dt > 0 and end_count > start_count:
                    return (end_count - start_count) / dt
                return 0.0

        return 0.0

    def is_active(self, app: str, book_id: int, stale_threshold: float = 120) -> bool:
        """Is this download actively receiving new chapters?

        Active = chapter count increased within the last stale_threshold seconds.
        """
        key = (app, book_id)
        hist = self.history.get(key, [])
        if len(hist) < 2:
            return False

        now_ts = hist[-1][0]
        # Find last time count changed
        for i in range(len(hist) - 1, 0, -1):
            if hist[i][1] != hist[i - 1][1]:
                last_change = hist[i][0]
                return (now_ts - last_change) < stale_threshold
        return False

    def get_active_downloads(
        self, snapshot: Snapshot, stale_threshold: float = 120
    ) -> list[ActiveDownload]:
        """Identify actively downloading books across all apps."""
        active = []

        for app, books in snapshot.db_books.items():
            counts = snapshot.db_chapter_counts.get(app, {})
            for book in books:
                bid = book.book_id
                count = counts.get(bid, 0)
                target = book.latest_index

                if target <= 0 or count >= target:
                    continue

                if not self.is_active(app, bid, stale_threshold):
                    continue

                rate = self.get_rate(app, bid)
                remaining = target - count
                eta = remaining / rate if rate > 0 else 0

                active.append(ActiveDownload(
                    book_id=bid,
                    name=book.name,
                    app=app,
                    current=count,
                    target=target,
                    rate=rate,
                    eta_seconds=eta,
                ))

        return active


# ── TUI Rendering ─────────────────────────────────────────────────────────────

def format_bytes(n: int) -> str:
    if n < 1024:
        return f"{n}B"
    elif n < 1024 * 1024:
        return f"{n / 1024:.1f}KB"
    elif n < 1024 * 1024 * 1024:
        return f"{n / (1024*1024):.1f}MB"
    return f"{n / (1024*1024*1024):.1f}GB"


def format_eta(seconds: float) -> str:
    if seconds <= 0:
        return "--"
    if seconds < 60:
        return f"~{int(seconds)}s"
    elif seconds < 3600:
        return f"~{int(seconds // 60)}m {int(seconds % 60)}s"
    return f"~{int(seconds // 3600)}h {int((seconds % 3600) // 60)}m"


def format_rate(rate: float) -> str:
    if rate <= 0:
        return "stalled"
    if rate >= 1:
        return f"{rate:.1f}/s"
    return f"{rate * 60:.0f}/min"


def build_header(snapshot: Snapshot, start_time: float, interval: int) -> Panel:
    text = Text(justify="center")
    text.append("MTC Crawling Progress Dashboard\n", style="bold cyan")

    if snapshot.timestamp > 0:
        ts = time.strftime("%H:%M:%S", time.localtime(snapshot.timestamp))
        uptime = int(snapshot.timestamp - start_time)
        uptime_str = f"{uptime // 60}m {uptime % 60}s" if uptime >= 60 else f"{uptime}s"
        text.append(f"Last poll: {ts}  •  Interval: {interval}s  •  Uptime: {uptime_str}")
    else:
        text.append("Loading...", style="dim")

    return Panel(text, style="bright_blue")


def build_db_overview(snapshot: Snapshot) -> Panel:
    parts = []

    for app in ["debug", "debug2"]:
        if app not in snapshot.db_accessible:
            continue

        label = "App 1 (debug)" if app == "debug" else "App 2 (debug2)"

        if not snapshot.db_accessible.get(app, False):
            error = snapshot.db_errors.get(app, "unreachable")
            parts.append(f"  {label}: [red]✗ {error}[/red]")
            continue

        books = snapshot.db_books.get(app, [])
        counts = snapshot.db_chapter_counts.get(app, {})
        total_books = len(books)
        total_chapters = sum(counts.values())
        parts.append(
            f"  {label}: [green]✓[/green]  "
            f"{total_books} bookmarked books, "
            f"{total_chapters:,} total chapters in DB"
        )

    content = "\n".join(parts) if parts else "  [dim]No device data[/dim]"
    return Panel(content, title="[bold]Device DB Overview[/bold]", border_style="blue")


def build_active_downloads(active: list[ActiveDownload]) -> Panel:
    if not active:
        content = "  [dim]No active downloads detected[/dim]"
        return Panel(content, title="[bold]Active Downloads[/bold]", border_style="yellow")

    table = Table(show_header=True, header_style="bold", expand=True,
                  show_edge=False, pad_edge=False)
    table.add_column("App", width=6)
    table.add_column("Book", ratio=3)
    table.add_column("Progress", width=14, justify="right")
    table.add_column("Bar", ratio=2)
    table.add_column("Rate", width=10, justify="right")
    table.add_column("ETA", width=12, justify="right")

    for dl in active:
        pct = dl.current * 100 / dl.target if dl.target > 0 else 0
        pct_int = int(pct)

        # Build a text progress bar
        bar_width = 20
        filled = int(bar_width * pct / 100)
        bar = "█" * filled + "░" * (bar_width - filled)

        if pct >= 90:
            pct_style = "green"
        elif pct >= 50:
            pct_style = "yellow"
        else:
            pct_style = "white"

        rate_str = format_rate(dl.rate)
        rate_style = "green" if dl.rate > 0 else "red"

        app_label = "db1" if dl.app == "debug" else "db2"
        name_short = dl.name[:35] + "…" if len(dl.name) > 35 else dl.name

        table.add_row(
            f"[cyan]{app_label}[/cyan]",
            name_short,
            f"[{pct_style}]{dl.current}/{dl.target} ({pct_int}%)[/{pct_style}]",
            f"[{pct_style}]{bar}[/{pct_style}]",
            f"[{rate_style}]{rate_str}[/{rate_style}]",
            format_eta(dl.eta_seconds),
        )

    return Panel(table, title="[bold]Active Downloads[/bold]", border_style="yellow")


def _sort_books(books: list[BookOnDisk], sort_key: str, reverse: bool) -> list[BookOnDisk]:
    """Sort books by the given key."""
    key_funcs = {
        "recent": lambda b: b.mtime,
        "name": lambda b: b.name.lower(),
        "size": lambda b: b.disk_bytes,
        "chapters": lambda b: b.txt_files,
        "id": lambda b: b.book_id,
    }
    fn = key_funcs.get(sort_key, key_funcs["recent"])
    # For name sort, ascending is more natural
    if sort_key == "name":
        reverse = not reverse
    return sorted(books, key=fn, reverse=reverse)


def _filter_books(books: list[BookOnDisk], query: str) -> list[BookOnDisk]:
    """Filter books by search query (matches name or ID)."""
    if not query:
        return books
    q = query.lower()
    return [b for b in books if q in b.name.lower() or q in str(b.book_id)]


def build_extraction_status(disk_books: list[BookOnDisk], ls: ListState) -> Panel:
    if not disk_books:
        content = "  [dim]No books in output directory[/dim]"
        return Panel(content, title="[bold]Extraction Status (output/)[/bold]",
                     border_style="green")

    total_bytes = sum(b.disk_bytes for b in disk_books)
    done_count = sum(
        1 for b in disk_books
        if b.chapters_saved > 0 and b.chapters_saved >= b.total_in_db > 0
    )
    total_count = len(disk_books)

    # Filter
    filtered = _filter_books(disk_books, ls.search_query)
    filtered_count = len(filtered)

    # Sort
    sorted_books = _sort_books(filtered, ls.sort_key, ls.sort_reverse)

    # Paginate
    if ls.view_size == VIEW_FULL:
        display_books = sorted_books
        page_label = "full"
    else:
        start = ls.page * ls.view_size
        end = start + ls.view_size
        display_books = sorted_books[start:end]
        total_pages = ls.page_count(filtered_count)
        page_label = f"page {ls.page + 1}/{total_pages}"

    # Search bar
    search_line = ""
    if ls.search_mode:
        search_line = f"  [bold yellow]Search:[/bold yellow] {ls.search_buf}[blink]|[/blink]\n"
    elif ls.search_query:
        search_line = f"  [yellow]Filter:[/yellow] \"{ls.search_query}\" ({filtered_count}/{total_count} matched)  [dim]Esc to clear[/dim]\n"

    # View label
    if ls.view_size == VIEW_COLLAPSED:
        view_label = "3"
    elif ls.view_size == VIEW_EXPANDED:
        view_label = "10"
    else:
        view_label = "all"

    # Title with sort + view info
    sort_label = SORT_LABELS[ls.sort_key]
    title = (
        f"[bold]Extraction Status[/bold]  "
        f"[dim]sort:[/dim] {sort_label}  "
        f"[dim]view:[/dim] {view_label}  "
        f"[dim]{page_label}[/dim]"
    )

    table = Table(show_header=True, header_style="bold", expand=True,
                  show_edge=False, pad_edge=False)
    table.add_column("ID", width=7, justify="right")
    table.add_column("Book", ratio=3)
    table.add_column("On Disk", width=9, justify="right")
    table.add_column("In DB", width=7, justify="right")
    table.add_column("Size", width=8, justify="right")
    table.add_column("Status", width=10, justify="center")

    for book in display_books:
        name_short = book.name[:38] + "…" if len(book.name) > 38 else book.name
        size_str = format_bytes(book.disk_bytes)

        if book.chapters_saved > 0 and book.chapters_saved >= book.total_in_db > 0:
            status = "[green]✓ Done[/green]"
        elif book.total_in_db == 0 and book.chapters_saved == 0:
            status = "[dim]Empty[/dim]"
        elif book.txt_files > 0:
            status = "[yellow]Partial[/yellow]"
        else:
            status = "[dim]Pending[/dim]"

        table.add_row(
            str(book.book_id),
            name_short,
            str(book.txt_files),
            str(book.total_in_db) if book.total_in_db > 0 else "--",
            size_str,
            status,
        )

    summary = (
        f"\n  [bold]{total_count}[/bold] books on disk  •  "
        f"[green]{done_count}[/green] fully extracted  •  "
        f"[bold]{format_bytes(total_bytes)}[/bold] total"
    )

    parts = []
    if search_line:
        parts.append(Text.from_markup(search_line))
    parts.append(table)
    parts.append(Text.from_markup(summary))

    return Panel(
        Group(*parts),
        title=title,
        border_style="green",
    )


def build_bookmarks(snapshot: Snapshot, disk_books: list[BookOnDisk]) -> Panel:
    """Show bookmarked books from device DB with their download/extraction status."""
    # Collect all bookmarked books across apps, dedup by book_id
    all_books: dict[int, BookInDB] = {}
    for app in ["debug", "debug2"]:
        for book in snapshot.db_books.get(app, []):
            if book.book_id not in all_books:
                all_books[book.book_id] = book

    if not all_books:
        content = "  [dim]No bookmarks (device not connected?)[/dim]"
        return Panel(content, title="[bold]Bookmarked Books[/bold]",
                     border_style="magenta")

    # Build a lookup of extracted books
    disk_lookup: dict[int, BookOnDisk] = {b.book_id: b for b in disk_books}

    # Merge chapter counts across apps
    all_counts: dict[int, int] = {}
    for app in ["debug", "debug2"]:
        for bid, cnt in snapshot.db_chapter_counts.get(app, {}).items():
            all_counts[bid] = max(all_counts.get(bid, 0), cnt)

    table = Table(show_header=True, header_style="bold", expand=True,
                  show_edge=False, pad_edge=False)
    table.add_column("#", width=3, justify="right")
    table.add_column("ID", width=7, justify="right")
    table.add_column("Book", ratio=3)
    table.add_column("Latest", width=7, justify="right")
    table.add_column("In DB", width=7, justify="right")
    table.add_column("On Disk", width=8, justify="right")
    table.add_column("Status", width=12, justify="center")

    books_sorted = sorted(all_books.values(), key=lambda b: b.book_id, reverse=True)

    for i, book in enumerate(books_sorted, 1):
        bid = book.book_id
        name_short = book.name[:35] + "…" if len(book.name) > 35 else book.name
        latest = book.latest_index
        in_db = all_counts.get(bid, 0)
        on_disk_book = disk_lookup.get(bid)
        on_disk = on_disk_book.txt_files if on_disk_book else 0

        if on_disk_book and on_disk_book.chapters_saved >= on_disk_book.total_in_db > 0:
            status = "[green]✓ Extracted[/green]"
        elif in_db >= latest > 0:
            status = "[cyan]Downloaded[/cyan]"
        elif in_db > 0:
            pct = in_db * 100 // latest if latest > 0 else 0
            status = f"[yellow]DL {pct}%[/yellow]"
        else:
            status = "[dim]Bookmarked[/dim]"

        table.add_row(
            str(i),
            str(bid),
            name_short,
            str(latest) if latest > 0 else "--",
            str(in_db) if in_db > 0 else "--",
            str(on_disk) if on_disk > 0 else "--",
            status,
        )

    extracted = sum(
        1 for b in books_sorted
        if (d := disk_lookup.get(b.book_id)) and d.chapters_saved >= d.total_in_db > 0
    )
    summary = (
        f"\n  [bold]{len(books_sorted)}[/bold] bookmarked  •  "
        f"[green]{extracted}[/green] extracted  •  "
        f"[dim]{len(books_sorted) - extracted} remaining[/dim]"
    )

    return Panel(
        Group(table, Text.from_markup(summary)),
        title="[bold]Bookmarked Books[/bold]",
        border_style="magenta",
    )


def build_footer(snapshot: Snapshot, interval: int, ls: ListState) -> Panel:
    db_parts = []
    for app in ["debug", "debug2"]:
        if app not in snapshot.db_accessible:
            continue
        label = "DB1" if app == "debug" else "DB2"
        ok = snapshot.db_accessible.get(app, False)
        db_parts.append(f"{label}: [{'green' if ok else 'red'}]{'✓' if ok else '✗'}[/{'green' if ok else 'red'}]")

    status = "  •  ".join(db_parts) if db_parts else "[dim]Device monitoring off[/dim]"

    if ls.search_mode:
        text = (
            f"  [bold yellow]SEARCH MODE[/bold yellow] — "
            f"type to filter  •  [bold]Enter[/bold] apply  •  [bold]Esc[/bold] cancel"
        )
    else:
        text = (
            f"  [bold]e[/bold] view (3/10/full)  •  "
            f"[bold]j[/bold]/[bold]k[/bold] page  •  "
            f"[bold]s[/bold] sort  •  "
            f"[bold]/[/bold] search  •  "
            f"[bold]q[/bold] quit  •  "
            f"Poll: {interval}s  •  {status}"
        )
    return Panel(text, style="dim")


def build_dashboard(
    snapshot: Snapshot,
    active: list[ActiveDownload],
    start_time: float,
    interval: int,
    show_device: bool,
    ls: ListState,
) -> Table:
    """Compose the full dashboard layout as a single renderable."""
    panels = []
    panels.append(build_header(snapshot, start_time, interval))

    if show_device:
        panels.append(build_db_overview(snapshot))
        panels.append(build_active_downloads(active))
        panels.append(build_bookmarks(snapshot, snapshot.disk_books))

    panels.append(build_extraction_status(snapshot.disk_books, ls))
    panels.append(build_footer(snapshot, interval, ls))

    layout = Table.grid(expand=True)
    layout.add_column()
    for p in panels:
        layout.add_row(p)

    return layout


# ── Main Loop ─────────────────────────────────────────────────────────────────

def poll_once(
    output_dir: str,
    apps: list[str],
    show_device: bool,
) -> Snapshot:
    """Perform a single poll cycle and return a snapshot."""
    snap = Snapshot(timestamp=time.time())

    # Poll device DBs
    if show_device:
        for app in apps:
            result = query_db(app)
            if result is not None:
                books, counts = result
                snap.db_books[app] = books
                snap.db_chapter_counts[app] = counts
                snap.db_accessible[app] = True
            else:
                snap.db_books[app] = []
                snap.db_chapter_counts[app] = {}
                snap.db_accessible[app] = False
                snap.db_errors[app] = "unreachable"

    # Scan output directory
    snap.disk_books = scan_output_dir(output_dir)

    return snap


class KeyReader:
    """Non-blocking key reader using a background thread in raw terminal mode.

    A daemon thread blocks on stdin.read(1) in cbreak mode, pushing
    characters into a list that the main thread can poll without blocking.
    """

    def __init__(self):
        self._old_settings = None
        self._keys: list[str] = []
        self._running = False

    def start(self):
        try:
            fd = sys.stdin.fileno()
            self._old_settings = termios.tcgetattr(fd)
            tty.setcbreak(fd)
            self._running = True
            Thread(target=self._reader, daemon=True).start()
        except (termios.error, OSError, ValueError):
            pass

    def _reader(self):
        """Background thread: block on stdin and collect keypresses."""
        while self._running:
            try:
                ch = sys.stdin.read(1)
                if ch:
                    self._keys.append(ch)
                else:
                    break
            except (OSError, ValueError):
                break

    def read(self) -> str | None:
        """Return the next queued character, or None."""
        if self._keys:
            return self._keys.pop(0)
        return None

    def stop(self):
        self._running = False
        if self._old_settings is not None:
            try:
                termios.tcsetattr(sys.stdin, termios.TCSADRAIN, self._old_settings)
            except (termios.error, OSError):
                pass


def main():
    parser = argparse.ArgumentParser(
        description="Real-time crawling progress dashboard"
    )
    parser.add_argument(
        "--interval", type=int, default=5,
        help="Poll interval in seconds (default: 5)"
    )
    parser.add_argument(
        "--no-device", action="store_true",
        help="Skip device DB polling, only show output/ status"
    )
    parser.add_argument(
        "--single", action="store_true",
        help="Only monitor App 1 (debug), skip debug2"
    )
    parser.add_argument(
        "--output-dir", default=DEFAULT_OUTPUT_DIR,
        help="Path to crawler output directory"
    )
    args = parser.parse_args()

    output_dir = os.path.abspath(args.output_dir)
    show_device = not args.no_device
    apps = ["debug"] if args.single else ["debug", "debug2"]
    interval = max(1, args.interval)

    console = Console()
    tracker = ChangeTracker()
    start_time = time.time()
    ls = ListState()
    keys = KeyReader()

    def refresh_now():
        """Rebuild and repaint the dashboard immediately."""
        dashboard = build_dashboard(
            snap, active, start_time, interval, show_device, ls,
        )
        console.clear()
        live.update(dashboard, refresh=True)

    # Placeholders for the poll loop
    snap = Snapshot(timestamp=time.time())
    active: list[ActiveDownload] = []

    try:
        with Live(console=console, refresh_per_second=2) as live:
            # Start key reader AFTER Live takes over the terminal
            keys.start()

            # Show disk data immediately (fast), device DB comes on first poll
            snap.disk_books = scan_output_dir(output_dir)
            live.update(build_dashboard(
                snap, [], start_time, interval, show_device=False, ls=ls,
            ))

            while True:
                snap = poll_once(output_dir, apps, show_device)

                # Update change tracker with DB data
                if show_device:
                    for app in apps:
                        counts = snap.db_chapter_counts.get(app, {})
                        for bid, count in counts.items():
                            tracker.update(app, bid, count, snap.timestamp)

                active = tracker.get_active_downloads(snap) if show_device else []
                dashboard = build_dashboard(
                    snap, active, start_time, interval, show_device, ls,
                )
                live.update(dashboard)

                # Wait for interval, checking for key presses every 0.1s
                deadline = time.time() + interval
                while time.time() < deadline:
                    ch = keys.read()
                    if ch is None:
                        time.sleep(0.05)
                        continue

                    if ls.search_mode:
                        # In search mode: collect characters
                        if ch == "\n" or ch == "\r":
                            ls.apply_search()
                            refresh_now()
                        elif ch == "\x1b":  # Escape
                            ls.cancel_search()
                            refresh_now()
                        elif ch in ("\x7f", "\x08"):  # Backspace
                            ls.search_buf = ls.search_buf[:-1]
                            refresh_now()
                        elif ch.isprintable():
                            ls.search_buf += ch
                            refresh_now()
                    else:
                        # Normal mode
                        filtered_count = len(_filter_books(
                            snap.disk_books, ls.search_query
                        ))
                        if ch == "e":
                            ls.cycle_view()
                            refresh_now()
                        elif ch == "f":
                            ls.view_size = VIEW_FULL
                            ls.page = 0
                            refresh_now()
                        elif ch == "j" or ch == "n":
                            ls.next_page(filtered_count)
                            refresh_now()
                        elif ch == "k" or ch == "p":
                            ls.prev_page(filtered_count)
                            refresh_now()
                        elif ch == "s":
                            ls.cycle_sort()
                            refresh_now()
                        elif ch == "/":
                            ls.enter_search()
                            refresh_now()
                        elif ch == "\x1b":  # Escape clears search
                            if ls.search_query:
                                ls.clear_search()
                                refresh_now()
                        elif ch == "q":
                            raise KeyboardInterrupt

    except KeyboardInterrupt:
        pass
    finally:
        keys.stop()
        console.print("[dim]Dashboard stopped.[/dim]")


if __name__ == "__main__":
    main()
