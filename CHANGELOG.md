# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-02-25

### Added

- **BLIB v2 bundle format** (`binslib/src/lib/chapter-storage.ts`, `book-ingest/src/bundle.py`)
  - 256-byte per-chapter metadata block inline with compressed data: `chapter_id` (uint32), `word_count` (uint32), `title` (UTF-8, max 196B), `slug` (UTF-8, max 48B)
  - Enables DB recovery from bundles alone — chapter titles, slugs, and word counts can be reconstructed by scanning metadata blocks without any external source
  - Stored `chapter_id` enables O(missing) resume via reverse walk from last known ID instead of O(total) linked-list traversal from chapter 1
  - 16-byte v2 header with `meta_entry_size` field for future extensibility
  - Readers accept both v1 and v2; new writes always produce v2
  - Overhead: 256 bytes/chapter (~512 KB for a 2000-chapter book, ~6% of typical bundle)
- **`migrate_v2.py`** (`book-ingest/`)
  - Converts v1 bundles to v2 format with metadata from local SQLite DB or `--refetch` from API
  - Syncs DB chapter rows by decompressing bundle content to extract titles and word counts
  - Supports `--dry-run`, `--ids`, `--workers` for controlled migration
- **`sync-book/sync-bundles.sh`** (moved from root `sync-bundles.sh`)
  - Refactored into reusable `sync_dir()` function — no logic duplication between bundles and covers
  - Syncs covers (`binslib/public/covers/*.jpg`) alongside bundles by default
  - `--cover-only` flag to only sync covers
  - `--bundle-only` flag to only sync bundles (preserves old behavior)
  - Proper argument parsing with `--help`; direction and flags accepted in any order
- **`--cover-only` flag for meta-puller** (`meta-puller/pull_metadata.py`)
  - Downloads cover images directly to `binslib/public/covers/{book_id}.jpg`
  - Reads poster URLs from existing `metadata.json` to avoid unnecessary API calls
  - Falls back to API fetch (without saving metadata) when no local metadata exists
  - Composes with `--ids`, `--force`, `--dry-run`

### Changed

- **BLIB v2 writer in import pipeline** (`binslib/scripts/import.ts`)
  - `BundleWriter` now writes v2 format with inline chapter metadata
  - `chapters_saved` count derived from actual bundle entry count after flush
  - Chapter progress estimation enriched from DB for CLI-specified book IDs
- **BLIB v2 writer in book-ingest** (`book-ingest/ingest.py`, `book-ingest/src/bundle.py`)
  - Python `BundleWriter` produces v2 bundles with metadata blocks
  - Ingest pipeline populates `chapter_id`, `word_count`, `title`, `slug` per chapter

### Fixed

- **FK constraint on chapter flush** (`binslib/scripts/import.ts`) — ensure book row exists in DB before flushing chapter metadata to avoid foreign key violations
- **Chapter progress estimate** (`binslib/scripts/import.ts`) — CLI book IDs now enrich expected chapter counts from DB when `metadata.json` is unavailable

## [0.2.4] - 2026-02-24

### Changed

- **Pre-compress 3-tier skip optimization** (`binslib/scripts/pre-compress.ts`)
  - **Tier 1 — mtime fast skip**: compares bundle mtime vs source directory mtime (2 stat calls). If the directory hasn't changed since the bundle was written, skips instantly with zero file reads. Eliminates ~30-50 GB of unnecessary bundle reads on re-runs
  - **Tier 2 — index-only check**: new `readBundleIndices()` reads only the bundle header + index section (~16 KB for a 1000-chapter bundle) instead of `readBundleRaw()` which reads the entire multi-MB file and copies every compressed chunk
  - **Tier 3 — full merge**: `readBundleRaw()` is now only called when new chapters actually need to be written, instead of for every book
  - Work distribution changed from round-robin to contiguous ranges, reducing HDD seek thrashing when workers access nearby directories sequentially
  - Metadata chapter counts passed from main thread to workers, avoiding redundant bundle header reads for progress reporting
  - Removed redundant `existsSync` calls before `readFileSync` in the estimation loop
  - Re-run with 0 new chapters: **~25 hours → < 1 minute**

## [0.2.3] - 2026-02-23

### Changed

- **Rename `download_top1000.py` → `download_topN.py`** (`crawler-descryptor/`)
  - Accepts a positional argument `N` for the number of top books to download (replaces the implicit "1000" in the old name)
  - Default plan file changed from `ranking_books.json` (missing) to `fresh_books_download.json`
  - All download logic extracted to shared module; script is now a thin orchestrator
- **Rename `batch_download.py` → `download_batch.py`** (`crawler-descryptor/`)
  - Imports `AsyncBookClient` and `download_book` from shared `src/downloader.py` instead of inline copies
- **Bundle-aware download skip** (`crawler-descryptor/src/utils.py`)
  - `count_existing_chapters()` now returns the union of `.txt` file indices AND chapters in `binslib/data/compressed/{book_id}.bundle`
  - Downloads skip chapters that already exist in either form, avoiding redundant re-downloads
- **Bundle-aware catalog audit** (`crawler-descryptor/fetch_catalog.py`)
  - `audit()` now checks both crawler output and compressed bundles when classifying books as complete/partial/missing
  - Completion threshold changed from `>= api_ch * 0.95` to exact `>= api_ch`
- **Incremental pre-compress with gap validation** (`binslib/scripts/pre-compress.ts`)
  - Existing bundles are read and merged incrementally — only new `.txt` chapters are compressed, existing bundle data is preserved
  - Gap validation: if the first new chapter index is not `max(bundle) + 1`, the book is skipped and reported as a gap error
  - Gap errors are aggregated across all workers and displayed in the summary report and detail log
  - Exit code 1 if any gap errors occur (alongside existing failure check)
- **Import gap validation** (`binslib/scripts/import.ts`)
  - Before inserting chapters, validates that new `.txt` file indices are contiguous from the bundle's highest index
  - Gap errors are tracked in `ImportReport` with `gapErrors` count and `gapErrorDetails` list
  - Gap errors printed in the boxed report, detail log, and appended to the run log

### Added

- **`src/downloader.py`** (`crawler-descryptor/src/`)
  - Shared async download engine extracted from `download_top1000.py` and `batch_download.py`
  - `AsyncBookClient` class with parameterized `max_concurrent` and `request_delay`
  - `download_book(client, book_entry, label)` — unified function that accepts plan-file entries (with `first_chapter`) or bare `{"id": N}` dicts (fetches metadata automatically)
- **`read_bundle_indices(book_id)`** (`crawler-descryptor/src/utils.py`)
  - Reads BLIB binary header + index section to extract chapter indices from a `.bundle` file
- **`BundleWriter.maxIndex()` and `BundleWriter.indices()`** (`binslib/src/lib/chapter-storage.ts`)
  - `maxIndex()` returns the highest chapter index in the buffer (or `null` if empty)
  - `indices()` returns the full set of chapter indices currently buffered

## [0.2.2] - 2026-02-23

### Fixed

- **`zstd-napi` not in `serverExternalPackages`** (`binslib/next.config.ts`)
  - Turbopack failed to resolve `./build/Release/binding.node`, causing HTTP 500 on every page
  - Added `"zstd-napi"` alongside `"better-sqlite3"` so native addons are required at runtime instead of bundled

### Changed

- **Pre-compress fatal on missing dictionary** (`binslib/scripts/pre-compress.ts`)
  - Main thread now checks `data/global.dict` existence before scanning or spawning workers; exits with `FATAL` and code 1 if missing
  - Worker thread also validates the dict path on startup as defense-in-depth, reporting failure back to the main thread before exiting
  - `dictPath` is now passed unconditionally to workers (no longer silently downgraded to `null`)

### Added

- **Library audit script** (`binslib/scripts/audit.ts`)
  - Scans all crawler output directories and compressed bundles to report download completion and compression status
  - Reports: total book dirs, download complete vs partial vs empty, chapter deficit, metadata/cover presence, bundle coverage, compression ratio
  - Supports `--verbose` (list individual incomplete/uncompressed books), `--source mtc|ttv`, `--ids`
- **Decompression test script** (`binslib/scripts/test-decompress-100114.ts`)
  - Round-trip verification: decompresses every chapter from a `.bundle` and compares byte-for-byte against the original crawler `.txt` files

## [0.2.1] - 2026-02-22

### Changed

- **Zstd compression** for chapter storage (`binslib/`)
  - Switched from gzip to zstd (level 3) — ~10-15x faster compression, ~4x faster decompression
  - `chapter-storage.ts`: dual-read support (`.zst` first, `.gz` fallback), single-write `.zst` only
  - `export-from-files.ts`: exports chapters as `.txt.zst`, skips existing `.zst` or `.gz` files
  - Added `@aspect/zstd` dependency for native zstd bindings

## [0.2.0] - 2026-02-17

### Added

- **Progress dashboard** (`progress-checking/dashboard.py`)
  - Real-time terminal TUI powered by `rich`
  - Polls emulator SQLite DBs and `crawler/output/` directory
  - Device DB overview, active downloads with progress bars and ETA
  - Bookmarked books panel with per-book status
  - Extraction status with pagination (3 / 10 / full view)
  - Interactive controls: search (`/`), sort (`s`), page (`j`/`k`), view cycle (`e`)
  - Supports dual-app monitoring (`debug` + `debug2`)
  - Graceful degradation when emulator is unreachable
- **Project README** with architecture diagram, quick start, CLI usage for all scripts
- **`.gitignore`** excluding APKs, output data, temp DBs, IDE configs

## [0.1.0] - 2026-02-16

### Added

- **Single-book grabber** (`crawler/grab_book.py`)
  - API search (exact + fuzzy) for book ID and chapter count
  - UI automation: app launch, bookmark tab, search, 3-dot menu, download dialog
  - Pixel scanning for 3-dot icon and dialog field detection
  - Vietnamese text input via `uiautomator2`
  - DB polling every 10s with stall detection (5 min) and timeout (1h)
  - Chapter extraction to individual `.txt` files + combined book
- **Batch downloader** (`crawler/batch_grab.py`)
  - Reads bookmarked books from device DB
  - Loops through pending books calling `grab_book` flow
  - `--list` to show status, `--limit` to cap downloads
- **Parallel downloader** (`crawler/parallel_grab.py`)
  - Dual-emulator orchestration for ~2x throughput
  - Serialized UI automation, parallel background downloads
  - Processes books in pairs, polls both DBs simultaneously
  - `--setup` to copy auth from emulator 1 to emulator 2
- **Standalone extractor** (`crawler/extract_book.py`)
  - Poll DB and extract after manual in-app download trigger
- **Emulator launcher** (`crawler/start_emulators.sh`)
  - Starts both AVDs, waits for boot, installs APK, launches mitmproxy
- **Documentation**
  - `API.md` — endpoint docs, auth, response formats
  - `ENCRYPTION.md` — chapter encryption analysis, DB extraction approach
  - `KNOWLEDGE.md` — project knowledge base
  - `PARALLEL_DOWNLOAD.md` — dual-emulator setup and usage
  - `crawler/CONTEXT.md` — crawler architecture and flow notes

[0.3.0]: https://github.com/quocanh1897/mtc-crawler/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/quocanh1897/mtc-crawler/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/quocanh1897/mtc-crawler/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/quocanh1897/mtc-crawler/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/quocanh1897/mtc-crawler/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/quocanh1897/mtc-crawler/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/quocanh1897/mtc-crawler/releases/tag/v0.1.0
