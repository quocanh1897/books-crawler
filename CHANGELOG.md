# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

[0.2.2]: https://github.com/quocanh1897/mtc-crawler/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/quocanh1897/mtc-crawler/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/quocanh1897/mtc-crawler/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/quocanh1897/mtc-crawler/releases/tag/v0.1.0
