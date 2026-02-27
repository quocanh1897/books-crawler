# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-02-27

Multi-source ingestion (MTC + TTV), Vietnamese diacritics-tolerant search, and production-hardened Docker deployment.

### Added

- **Multi-source ingest pipeline** — `ingest.py` and `generate_plan.py` now accept `--source mtc|ttv` to crawl from either metruyencv (encrypted API) or truyen.tangthuvien.vn (HTML scraping)
- **Source abstraction layer** (`book-ingest/src/sources/`)
  - `base.py`: `BookSource` ABC + `ChapterData` NamedTuple — shared interface for all sources
  - `mtc.py`: `MTCSource` — wraps API client, AES-128-CBC decrypt, linked-list chapter walk (forward/reverse/resume)
  - `ttv.py`: `TTVSource` — async HTTP client, HTML parsers (listing, detail, chapter pages), book ID registry (10M+ offset), author ID registry (20M+ offset)
  - `__init__.py`: `create_source("mtc"|"ttv")` factory with lazy imports
- **TTV plan generation** — `generate_plan.py --source ttv` scrapes all TTV listing pages (~494 pages, ~9800 books), cross-references with local bundles, writes `data/books_plan_ttv.json`, pulls covers
- **TTV plan refresh** — `generate_plan.py --source ttv --refresh` re-fetches metadata from HTML detail pages
- **TTV title repair** — `repair_titles.py --source ttv` fetches correct `<h2>` titles from TTV chapter pages with async parallel workers and live progress output
- **`--force` flag** for `ingest.py` — deletes existing bundle + DB chapters and re-downloads from scratch; requires explicit book IDs, prompts for confirmation before deletion
- **`chapter_id` column** in DB `chapters` table — mirrors the MTC API chapter ID stored in bundle metadata; enables future SQL-based resume walk lookups
- **API request logging** (`binslib/src/lib/api-logger.ts`) — all vbook-extension endpoints log method, path, params, status, and duration to stdout via `process.stdout.write` (Docker-safe unbuffered)
- **Cross-source vbook search** — `/api/search` accepts `?source=all` parameter; vbook-extension passes it to search across MTC + TTV books
- **FTS5 Vietnamese search integration tests** (`binslib/test/test-fts-search.ts`) — 36 tests covering tokenizer config, diacritics stripping, đ→d normalization, triggers, ensureFts consistency, buildFtsQuery correctness, and source file sync checks
- **Docker startup migration** — `migrate.cjs` (esbuild-bundled) runs at container startup against the volume-mounted production DB, not just at build time
- **`sync-book` auto-restart** — `sync-bundles.sh` restarts the binslib container after DB upload to trigger FTS migration

### Changed

- **Plan file naming** — `fresh_books_download.json` → `books_plan_mtc.json`; TTV plan: `books_plan_ttv.json`
- **FTS5 tokenizer** — `remove_diacritics 0` → `remove_diacritics 2` so searches work with and without Vietnamese diacritics (critical for vbook Android extension which may strip diacritics from user input)
- **đ/Đ → d/D normalization** — applied in FTS index content, triggers, `buildFtsQuery()` (search API + web UI), and `ensureFts()` because the unicode61 tokenizer treats Vietnamese đ as a letter variant, not a combining diacritic
- **`ensureFts()` in `db/index.ts`** — updated to use `remove_diacritics 2` with đ→d normalization, matching `migrate.ts`; uses separate `exec()` calls instead of multi-statement block
- **TTV author IDs** — 20M+ offset (`AUTHOR_ID_OFFSET = 20_000_000`) to avoid namespace collision with MTC author IDs in the shared `authors` table
- **TTV slugs** — books carry two slugs: `slug` (ASCII-clean via `slugify(name)` for DB/website routing) and `ttv_slug` (original TTV URL, may contain diacritics, for chapter fetching)
- **`MTCSource.fetch_book_metadata()`** — applies fix-author logic (generate synthetic author from creator when API returns empty/placeholder author name)
- **`--update-meta-only` with book IDs** — now enriches bare `{"id": N}` entries from the plan file instead of writing garbage metadata
- **`--pages` default** for TTV — changed from 50 to 0 (all available pages) to scrape the full ~9800 book catalog
- **`.gitignore`** — `data/books_plan_*.json`, `data/book_registry_*.json`, `data/catalog_audit.json` patterns
- **Dockerfile** — bundles `migrate.cjs` via esbuild at build time; CMD changed to `sh -c "node migrate.cjs && node server.js"` for startup migration
- **FTS migration** — uses separate `sqlite.exec()` calls per statement (single multi-statement exec silently failed to DROP virtual tables in Docker/esbuild environments)
- **FTS verification** — 3-check validation after rebuild: tokenizer definition, đ→d normalization, and diacritics stripping; auto-rebuilds if any check fails
- **`binslib/` version** — 0.3.1 → 1.0.0
- **`README.md`** — updated architecture diagram (TTV active, not dormant), layer details, subprojects table, quick start with TTV examples, storage layout with source abstraction
- **`book-ingest/README.md`** — multi-source description, source table, new plan file names, options table, typical workflow, file paths, source files, dependencies (added beautifulsoup4, lxml)
- **`crawler-tangthuvien/`** — marked as legacy (functionality now integrated into `book-ingest`)

### Fixed

- **TTV chapter titles** — 171 books (92K chapters) had body text as titles from old import.ts pipeline; `parse_chapter()` now strips embedded `<h5>` tags and title-prefix from body; `repair_titles.py --source ttv` fixes existing data
- **TTV non-ASCII slugs** — 213 books had Vietnamese diacritics or Chinese characters in slugs (e.g. `van-co-mạnh-nhát-tong`), causing 404 on website; slugs now generated from `slugify(name)`
- **TTV author ID collision** — TTV author_id=357 ("Lão Lễ Phi Đao") overwrote MTC author_id=357 ("Yếm Bút Tiêu Sinh"); 3,561 MTC author names restored from API
- **Empty-author bug** — `MTCSource` returned raw API author `{id: 3167, name: ""}` without fix-author logic; 102 books fixed
- **`--update-meta-only` corruption** — bare book IDs produced `name="?", slug="", chapter_count=0` in DB
- **`MTCSource` class structure** — `_plan_walk`, `_walk_forward`, `_walk_reverse`, `_decrypt` were accidentally outside the class body
- **vbook search returning 0 results** — FTS5 used `remove_diacritics 0` (exact match only); vbook Android JS runtime strips diacritics from input
- **FTS `exec()` silent failure** — single multi-statement `sqlite.exec()` silently failed to DROP FTS virtual tables in Docker; split into individual calls
- **`ensureFts()` overwriting migration** — `db/index.ts` forced `remove_diacritics 0` at every server startup, undoing `migrate.ts`'s `remove_diacritics 2`
- **Docker migration targeting throwaway DB** — `RUN npx tsx scripts/migrate.ts` in Dockerfile only touched build-time DB; production DB in volume mount was never migrated
- **Docker log buffering** — `console.log` in API routes was buffered; switched to `process.stdout.write` for immediate output

## [0.4.0] - 2026-02-26

### Added

- **`generate_plan.py`** (`book-ingest/`) — unified plan generation tool merging `meta-puller --meta-only` and `refresh_catalog.py` into one file
  - Default mode: paginate API catalog, cross-reference with local bundles, write plan, pull missing covers
  - `--refresh`: read existing plan, fetch full per-book metadata (author, genres, tags, synopsis, poster, stats) via async batch fetch (150 concurrent workers)
  - `--scan` (with `--refresh`): probe every ID in the MTC range (100003–153500+) to discover books invisible to the catalog listing endpoint
  - `--cover-only`: download missing cover images to `binslib/public/covers/`
  - `--fix-author`: generate synthetic authors from creators (now default: on; disable with `--no-fix-author`)
  - `--min-chapters`, `--workers`, `--delay`, `--force`, `--dry-run`
- **`plan/CLEANUP_PLAN.md`** — completed cleanup plan documenting the full dependency audit, 4-phase execution, and final architecture

### Changed

- **`epub-converter/`** — reads from BLIB bundles + SQLite DB instead of `crawler/output/` `.txt` files
  - `BundleReader` class in `epub_builder.py`: parses BLIB v1/v2, decompresses with zstd + global dictionary
  - Metadata from `binslib/data/binslib.db` (SQLite) instead of `metadata.json` files
  - Covers from `binslib/public/covers/{book_id}.jpg` instead of `crawler/output/{book_id}/cover.jpg`
  - EPUB cache: `binslib/data/epub/{book_id}_{chapter_count}.epub` — skips conversion when cached chapter count matches bundle, auto-cleans stale entries
  - Removed: AUDIT.md integration, meta-puller subprocess invocation, `--no-audit` flag
  - Replaced `httpx` dependency with `pyzstd`
- **`meta-puller/pull_metadata.py`** — removed all `crawler/output/` dependency
  - Discovers books from `binslib/data/compressed/*.bundle` instead of `crawler/output/`
  - Inlined API config (fixed the broken `sys.path` import from `../crawler`)
  - `--meta-only` generates download plan to `book-ingest/data/`
  - `--cover-only` pulls covers directly to `binslib/public/covers/`
- **binslib EPUB API routes** (`download/`, `download-status/`, `epub/`)
  - `EPUB_OUTPUT_DIR` (subdirectory per book) → `EPUB_CACHE_DIR` (flat `data/epub/`)
  - `findEpub()` → `findCachedEpub()` with `{book_id}_{chapter_count}.epub` filename pattern
  - Cache freshness: compares embedded chapter count vs DB chapter count
  - `download-status` response now includes `epub_chapter_count` and `db_chapter_count`
- **`binslib/docker-compose.yml`** — removed stale `crawler/output`, `crawler-tangthuvien/output`, `meta-puller` volume mounts and `CRAWLER_OUTPUT_DIR`, `TTV_CRAWLER_OUTPUT_DIR`, `META_PULLER_DIR`, `EPUB_OUTPUT_DIR` env vars; added `ZSTD_DICT_PATH`, `EPUB_CACHE_DIR`
- **`book-ingest/ingest.py`** — `DEFAULT_PLAN` path changed to `book-ingest/data/books_plan_mtc.json`
- **`book-ingest/refresh_catalog.py`** — `DEFAULT_INPUT`/`DEFAULT_OUTPUT` updated to `book-ingest/data/books_plan_mtc.json`; `--fix-author` now defaults to true (disable with `--no-fix-author` or `--fix-author 0`)
- **`book-ingest/src/utils.py`** — removed `CRAWLER_OUTPUT` path and legacy `.txt` functions (`get_output_dir`, `save_chapter`, `save_metadata`); `count_existing_chapters()` now reads from bundles only
- **`book-ingest/src/decrypt.py`** — converted from symlink to real file (was `-> ../../crawler-descryptor/src/decrypt.py`)
- **`README.md`** — rewrote architecture diagram, subprojects table (9 → 6 active), quick start (5-step workflow), technical details, storage layout, platform compatibility
- **`binslib/README.md`** — removed ~300 lines of import/pre-compress/audit documentation; rewrote data pipeline diagram, setup, npm scripts, env vars, Docker section; added EPUB Generation section

### Removed

- **`crawler-emulator/`** — deprecated emulator-based crawler (11 files). Zero dependencies. Marked `[DEPRECATED]` since v0.2.0.
- **`crawler-descryptor/`** — direct API decryption scripts, Frida hooks, tests, samples (37 files, ~1.6M lines). All functionality absorbed into `book-ingest/`. Docs archived to `plan/archive/crawler-descryptor/`.
- **`crawler/zstd-benchmark/`** — standalone compression benchmark (10 files). Unreferenced.
- **`binslib/scripts/import.ts`** — superseded by `book-ingest/ingest.py`
- **`binslib/scripts/pre-compress.ts`** — superseded (book-ingest compresses inline)
- **`binslib/scripts/audit.ts`** — superseded by `book-ingest --audit-only` and `generate_plan.py`
- **`binslib/scripts/is-safe-to-delete.ts`** — coupled to deleted import.ts workflow
- **`binslib/scripts/pull-covers.ts`** — superseded by `generate_plan.py --cover-only`
- **`binslib/scripts/test-export-book.ts`** — one-time test script
- **binslib npm scripts**: `import`, `import:full`, `import:cron`, `pre-compress`
- **binslib dependencies**: `chalk`, `cli-progress`, `@types/cli-progress`

## [0.3.1] - 2026-02-26

### Fixed

- **Empty chapter body in Docker reader** — bundle files were created with `600` permissions (owner-only) by both `writeBookBundleRaw` (Node.js) and `write_bundle` (Python `tempfile.mkstemp`). The Docker container ran as `nextjs` (UID 1001) while files were owned by the host user (UID 1000), causing `readBundleIndex` to silently return `null` on EACCES. Bundles are now written with `644` permissions in both writers.
- **Docker container UID mismatch** — removed the `nextjs` user from the Dockerfile; container now runs as root to avoid permission issues with host-mounted volumes regardless of host UID. Added native build deps (`python3 make g++`) to the `deps` stage for `zstd-napi` compilation.
- **`import.ts` cascade-deleting chapters** — `INSERT OR REPLACE INTO books` triggered `ON DELETE CASCADE` on the chapters table, wiping all chapter rows whenever a book was re-imported. Changed to `INSERT ... ON CONFLICT(id) DO UPDATE SET` (matching `book-ingest/src/db.py`) to preserve existing chapters.
- **`import.ts` skip logic ignoring bundle-only books** — when `crawler/output/{id}/` existed with `metadata.json` but no `.txt` files (common for books ingested via `book-ingest`), the skip condition `txtOnDisk > 0` was always false, forcing unnecessary re-imports. Now checks `listCompressedChapters()` to also account for chapters in bundles.

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

[0.4.0]: https://github.com/quocanh1897/mtc-crawler/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/quocanh1897/mtc-crawler/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/quocanh1897/mtc-crawler/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/quocanh1897/mtc-crawler/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/quocanh1897/mtc-crawler/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/quocanh1897/mtc-crawler/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/quocanh1897/mtc-crawler/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/quocanh1897/mtc-crawler/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/quocanh1897/mtc-crawler/releases/tag/v0.1.0
