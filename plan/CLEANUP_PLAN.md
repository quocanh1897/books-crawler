# Cleanup Plan — COMPLETED

All phases executed on the `cleanup` branch. The project has been streamlined from 9 subprojects to 6 active ones, with `crawler/output/` retained as data-only storage.

## Final Workflow

| Task | Tool | Notes |
|------|------|-------|
| Generate plan + pull covers | `book-ingest/generate_plan.py` | Catalog pagination, bundle cross-ref, per-book enrichment, ID-range scan, cover download |
| Refresh plan with full metadata | `book-ingest/generate_plan.py --refresh` | Async batch fetch (150 workers), `--scan` for discovery, `--fix-author` |
| Download + decrypt + compress + DB | `book-ingest/ingest.py` | Reads plan from `data/fresh_books_download.json` |
| Update metadata only | `book-ingest/ingest.py --update-meta-only` | Refresh DB metadata without downloading chapters |
| EPUB generation | `epub-converter/convert.py` | Reads bundles + DB, caches in `binslib/data/epub/{id}_{count}.epub` |
| Sync files across machines | `sync-book/sync-bundles.sh` | Bundles + covers + DB via rsync (`--db-only`, `--cover-only`, `--bundle-only`) |
| DB migrations | `binslib/scripts/migrate.ts` | Drizzle + FTS5 setup |

---

## What Was Done

### Phase 0: Refactors (pre-cleanup)

| Change | Details |
|--------|---------|
| ✅ `meta-puller/pull_metadata.py` refactored | Removed `crawler/output/` dependency. Discovers from bundles. `--meta-only` generates plan. `--cover-only` pulls covers. Inlined API config. |
| ✅ `epub-converter/` refactored | Reads from BLIB bundles (zstd decompression) + SQLite DB. Caches EPUBs as `{id}_{count}.epub`. Removed AUDIT.md, meta-puller subprocess, all crawler/output refs. Replaced `httpx` with `pyzstd`. |
| ✅ `book-ingest/ingest.py` DEFAULT_PLAN updated | Path changed to `book-ingest/data/fresh_books_download.json` |
| ✅ binslib API routes updated | `EPUB_OUTPUT_DIR` → `EPUB_CACHE_DIR`. `findEpub()` → `findCachedEpub()` with `{id}_{count}.epub` pattern. Cache freshness via chapter count comparison. |
| ✅ `book-ingest/generate_plan.py` created | Merged `meta-puller --meta-only` + `refresh_catalog.py` into one tool with all features: catalog pagination, async per-book enrichment, `--scan`, `--fix-author`, `--cover-only`, `--min-chapters` |

### Phase 1: Immediate deletions

| Target | Files | Reason |
|--------|-------|--------|
| ✅ `crawler-emulator/` | 11 files | Deprecated emulator-based crawler. Zero dependencies. |
| ✅ `crawler/zstd-benchmark/` | 10 files | Standalone benchmark tool. Unreferenced. |
| ✅ `binslib/scripts/import.ts` | — | Superseded by `book-ingest/ingest.py` |
| ✅ `binslib/scripts/pre-compress.ts` | — | Superseded — `book-ingest` compresses inline |
| ✅ `binslib/scripts/audit.ts` | — | Superseded by `book-ingest --audit-only` + `generate_plan.py --meta-only` |
| ✅ `binslib/scripts/is-safe-to-delete.ts` | — | Coupled to import.ts workflow |
| ✅ `binslib/scripts/pull-covers.ts` | — | Superseded by `generate_plan.py --cover-only` |
| ✅ `binslib/scripts/test-export-book.ts` | — | One-time test script |
| ✅ `binslib/package.json` cleaned | — | Removed npm scripts: `import`, `import:full`, `import:cron`, `pre-compress`. Removed deps: `chalk`, `cli-progress`, `@types/cli-progress` |

### Phase 2: Migrate dependencies out of `crawler-descryptor/`

| Step | What | How |
|------|------|-----|
| ✅ 2a | Break `decrypt.py` symlink | `rm` symlink, `cp` real file into `book-ingest/src/decrypt.py` |
| ✅ 2b | Copy enriched plan file + update `refresh_catalog.py` | Copied 1.6M-line enriched plan to `book-ingest/data/`. Updated `DEFAULT_INPUT`/`DEFAULT_OUTPUT` paths. |
| ✅ 2c | Copy `src/utils.py` | Copied to `book-ingest/src/utils.py`. Removed legacy `CRAWLER_OUTPUT`, `get_output_dir`, `save_chapter`, `save_metadata`. `count_existing_chapters()` now reads bundles only. |
| ✅ 2d | Clean comment references | Removed `crawler-descryptor` mentions from `ingest.py`, `src/api.py`, `repair_titles.py` |
| ✅ 2e | Archive docs | `API.md`, `ENCRYPTION.md`, `KNOWLEDGE.md`, `PLAN.md`, `README.md` → `plan/archive/crawler-descryptor/` |

### Phase 3: Delete `crawler-descryptor/`

| Target | Files | Notes |
|--------|-------|-------|
| ✅ `crawler-descryptor/` | 37 files (~1.6M lines) | Config, downloaders, Frida hooks, tests, samples, plan files. All superseded by `book-ingest/`. |
| ✅ Stale references cleaned | `book-ingest/src/utils.py` | Last remaining `CRAWLER_OUTPUT` reference removed |
| ✅ Zero dangling references | Verified via grep across `*.py`, `*.ts`, `*.yml` | No runtime references to `crawler-descryptor` remain |

### Phase 4: Update docs and config

| File | Changes |
|------|---------|
| ✅ `README.md` | Rewrote architecture diagram (removed crawler/crawler-descryptor, shows generate_plan → ingest → storage → web). Updated subprojects table (6 active). New 5-step quick start. Updated technical details (encryption, bundle format, storage layout). |
| ✅ `binslib/README.md` | Removed ~300 lines of import/pre-compress/audit docs. Rewrote data pipeline diagram. Updated setup, npm scripts (6 down from 10), env vars, Docker section. Added EPUB Generation section. |
| ✅ `binslib/docker-compose.yml` | Removed 4 stale volume mounts (`crawler/output`, `crawler-tangthuvien/output`, `meta-puller`). Removed 5 env vars (`CRAWLER_OUTPUT_DIR`, `TTV_CRAWLER_OUTPUT_DIR`, `META_PULLER_DIR`, `EPUB_OUTPUT_DIR`). Added `ZSTD_DICT_PATH`, `EPUB_CACHE_DIR`. |
| ✅ `meta-puller/CONTEXT.md` | Rewrote for bundle-based workflow. Added note recommending `generate_plan.py` as replacement. |

---

## Final Architecture

```
book-ingest/                    ← primary MTC pipeline
  ├── generate_plan.py          ← catalog + covers + plan (merged meta-puller + refresh_catalog)
  ├── ingest.py                 ← download → decrypt → compress → bundle + DB
  ├── refresh_catalog.py        ← legacy (superseded by generate_plan.py --refresh)
  ├── repair_titles.py          ← fix chapter titles from API
  ├── migrate_v2.py             ← bundle v1→v2 migration
  ├── data/
  │   └── fresh_books_download.json
  └── src/
      ├── api.py                ← async client (own config + rate limiting)
      ├── decrypt.py            ← AES-128-CBC decryption (real file, was symlink)
      ├── utils.py              ← bundle helpers (from crawler-descryptor, cleaned)
      ├── bundle.py             ← BLIB v1/v2 reader + v2 writer
      ├── compress.py           ← zstd with global dictionary
      ├── cover.py              ← async cover download
      └── db.py                 ← SQLite ops (upsert, chapters, change detection)

meta-puller/                    ← legacy cover + catalog tool
  └── pull_metadata.py          ← self-contained (inline config, bundle discovery)
                                   Prefer generate_plan.py instead.

sync-book/                      ← file sync across machines
  └── sync-bundles.sh           ← bundles + covers + DB via rsync

crawler/output/                 ← data only, no code, no active runtime consumers
  └── {book_id}/                   (metadata.json, cover.jpg, *.txt)

crawler-tangthuvien/            ← kept as-is (dormant TTV scraper)
  └── output/{book_id}/

binslib/
  ├── data/
  │   ├── binslib.db            ← SQLite (metadata, chapters, FTS5)
  │   ├── compressed/*.bundle   ← per-book chapter bundles (BLIB v2)
  │   ├── epub/{id}_{count}.epub ← cached EPUBs
  │   └── global.dict           ← zstd dictionary
  ├── public/covers/            ← {book_id}.jpg cover images
  ├── scripts/
  │   ├── migrate.ts            ← Drizzle migrations + FTS5 setup
  │   └── warmup-cache.js       ← production SQLite cache warmup
  └── src/                      ← Next.js 16 web reader + API routes

epub-converter/                 ← reads bundles + DB + covers (no crawler/output)
  ├── convert.py                ← CLI with cache management
  └── epub_builder.py           ← BundleReader + EPUB 3.0 builder

plan/
  ├── CLEANUP_PLAN.md           ← this file
  └── archive/
      └── crawler-descryptor/   ← archived docs (API.md, ENCRYPTION.md, etc.)

vbook-extension/                ← vBook Android app extension
```

---

## Stats

| Metric | Value |
|--------|-------|
| Directories deleted | 3 (`crawler-emulator/`, `crawler-descryptor/`, `crawler/zstd-benchmark/`) |
| Scripts deleted | 6 (`import.ts`, `pre-compress.ts`, `audit.ts`, `is-safe-to-delete.ts`, `pull-covers.ts`, `test-export-book.ts`) |
| Total files removed | ~100 |
| Total lines removed | ~1.6M (mostly the enriched plan JSON in crawler-descryptor) |
| Files migrated | `decrypt.py` (symlink → real), `utils.py` (cleaned), `fresh_books_download.json` (enriched copy), 5 docs archived |
| New files created | `generate_plan.py` (~1100 lines, merges 2 tools) |
| npm deps removed | 3 (`chalk`, `cli-progress`, `@types/cli-progress`) |
| npm scripts removed | 4 (`import`, `import:full`, `import:cron`, `pre-compress`) |
| Docker volumes removed | 4 stale mounts |
| Docker env vars removed | 5 stale vars |
| Tests executed | 49 across phases 0–4 (all passed) |

---

## Not In Scope (future)

| Item | Risk | Prerequisite |
|------|------|-------------|
| Delete `crawler/output/*.txt` chapter files | High | All books fully ingested via `book-ingest`. Run safety audit first. |
| Delete `meta-puller/` entirely | Low | Verify `generate_plan.py` covers all use cases. |
| Delete `book-ingest/refresh_catalog.py` | Low | Superseded by `generate_plan.py --refresh`. Keep for reference. |
| Delete `crawler-tangthuvien/` | None | Decision needed on TTV support. Currently dormant. |
| Migrate `binslib/Dockerfile` | Low | Update to remove any stale references to deleted scripts. |