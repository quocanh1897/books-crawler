# Progress Checking Dashboard — Plan

## Goal

A terminal-based real-time dashboard that polls two data sources — the device's SQLite DBs (via `adb`) and `crawler/output/` on disk — to show a live summary of all crawling activity. Supports both single-app and parallel (dual-app) download monitoring.

## Data Sources

### 1. SQLite DBs on device (via `adb shell run-as ... cat`)

Two app instances may be running simultaneously:

| App | Package | Temp DB |
|-----|---------|---------|
| MTC Debug | `com.novelfever.app.android.debug` | `/tmp/mtc_progress.db` |
| MTC Debug 2 | `com.novelfever.app.android.debug2` | `/tmp/mtc_progress2.db` |

**Tables queried:**

- `BaseBook` — all books known to the app (id, name, latestIndex, following, bookmarkId)
- `Chapter` — all downloaded chapters (id, bookId, index, name, content, slug)

**Derived metrics:**
- Per-book chapter count in DB
- Active downloads (chapter count increasing between polls)
- Download rate (chapters/second)
- ETA to completion

### 2. `crawler/output/` directory on disk

- `{book_id}/book.json` — metadata: book_id, book_name, chapters_saved, total_in_db
- `{book_id}/*.txt` — individual chapter files (name pattern: `NNNN_slug.txt`)
- Combined book file: `{book_name}.txt`

**Derived metrics:**
- Which books have been extracted to disk
- Extraction completeness (chapters on disk vs chapters in DB)
- Total disk usage

## Dashboard Layout

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                    MTC Crawling Progress Dashboard                       ┃
┃                    Last poll: 14:32:05 • Interval: 5s                    ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃  DEVICE DB OVERVIEW                                                     ┃
┃  App 1 (debug):  12 books, 3241 chapters │ App 2 (debug2): 10 books     ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃  ACTIVE DOWNLOADS (chapters increasing)                                 ┃
┃                                                                         ┃
┃  App   Book Name                    Progress       Rate      ETA        ┃
┃  ───   ─────────────────────────    ──────────     ─────     ────       ┃
┃  db1   Trường Sinh Tu Tiên...       237/500        ~2/s      ~2m        ┃
┃        ████████████░░░░░░░░░  47%                                       ┃
┃  db2   Nông Phu Thê                  45/200        ~1/s      ~3m        ┃
┃        ███░░░░░░░░░░░░░░░░░  22%                                       ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃  EXTRACTION STATUS (crawler/output/)                                    ┃
┃                                                                         ┃
┃  ID       Book Name                Extracted  DB Total  Disk    Status  ┃
┃  ───────  ─────────────────────    ─────────  ────────  ─────   ──────  ┃
┃  142310   Trường Sinh Tu Tiên...   308/308    308       4.2MB   ✓ Done  ┃
┃  147360   Chư Thiên Lãnh Chúa      437/437    437       6.1MB   ✓ Done  ┃
┃  148610   Hủ Bại Thế Giới            0/256    256       0B      Pending ┃
┃                                                                         ┃
┃  Total: 63 books on disk • 45 fully extracted • 126.3 MB               ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃  [q] quit • Poll: 5s • DB1: ✓ • DB2: ✓ • Uptime: 3m 24s               ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

## Architecture

Single-file Python script (`dashboard.py`) with these logical sections:

| Section | Responsibility |
|---------|---------------|
| **Constants** | ADB path, device, packages, output dir, temp DB paths |
| **DB poller** | Pull DB from device via `adb`, open with `sqlite3`, query `BaseBook` + `Chapter` |
| **Output scanner** | Walk `crawler/output/*/`, read `book.json`, count `.txt` files, sum disk usage |
| **Change detector** | Compare current vs previous poll snapshots, compute rates + ETAs |
| **TUI renderer** | `rich.live.Live` + `Table` + `Panel` + `Progress` for real-time display |
| **Main loop** | Parse CLI args → poll → diff → render → sleep → repeat |

## CLI Interface

```bash
cd progress-checking/
pip install rich
python dashboard.py                      # Default: 5s interval, both apps
python dashboard.py --interval 3         # Poll every 3 seconds
python dashboard.py --no-device          # Skip DB polling, only show output/ status
python dashboard.py --output-dir ../crawler/output  # Custom output path (default)
python dashboard.py --single             # Only monitor App 1 (no debug2)
```

## Dependencies

- `rich` — terminal UI (tables, live display, progress bars, panels)
- `sqlite3` — stdlib
- `subprocess` — stdlib (for adb commands)
- `pathlib` / `json` / `os` — stdlib

## Implementation Steps

1. Create `progress-checking/` directory with `PLAN.md` and `requirements.txt`
2. Implement DB pulling (reuse adb pattern from `grab_book.py`, separate temp path)
3. Implement output directory scanning
4. Implement change detection (snapshot diffing, rate calculation, ETA)
5. Build rich TUI layout with all panels
6. Wire up main loop with Live display
7. Add CLI arg parsing
8. Test

## Key Considerations

- **Non-destructive**: Uses its own temp DB path (`/tmp/mtc_progress*.db`) so it never conflicts with running `grab_book.py` or `parallel_grab.py`
- **Graceful degradation**: If device not connected or adb fails, shows output-only mode with a warning
- **Parallel awareness**: Monitors both `debug` and `debug2` app instances
- **Minimal overhead**: 5s default poll interval; DB pull is fast (~100ms)
