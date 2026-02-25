# Cleanup Plan

Audit of what can be safely deleted now that `book-ingest` is the primary pipeline for MTC books.

TTV (`crawler-tangthuvien/`) is kept as-is but is **not a factor** in deletion decisions — it is dormant and should not block cleanup of MTC tooling.

## Current Workflow

| Task | Tool | Notes |
|------|------|-------|
| Generate `fresh_books_download.json` | `crawler-descryptor/fetch_catalog.py` | Paginates API, cross-refs local data, outputs plan |
| Download + decrypt + compress + DB | `book-ingest/ingest.py` | Reads plan file, writes bundles + SQLite directly |
| Pull covers | `meta-puller/pull_metadata.py --cover-only` | Downloads to `binslib/public/covers/` |
| Sync files across machines | `sync-book/sync-bundles.sh` | Bundles + covers via rsync |
| EPUB generation | `epub-converter/` | Reads from `crawler/output/` |
| DB migrations | `binslib/scripts/migrate.ts` | Drizzle + FTS5 setup |

---

## Dependency Audit

### 1. `crawler/` — ⚠️ DATA directory, code can go

The `crawler/` directory contains no crawler code (that moved to `crawler-emulator/` long ago). It is purely a **data mount point**: `crawler/output/` holds 30,354 book directories with `.txt` chapters, `metadata.json`, and `cover.jpg` files.

**`crawler/output/` is referenced by:**

| File | How |
|------|-----|
| `meta-puller/pull_metadata.py` | `OUTPUT_DIR = ../crawler/output` — scans + writes metadata/covers |
| `epub-converter/convert.py` | `OUTPUT_DIR = crawler/output` — reads chapters for EPUB |
| `epub-converter/docker-compose.yml` | Volume mount `../crawler:/data/crawler` |
| `binslib/docker-compose.yml` | Volume mount `../crawler/output:/data/crawler-output` |
| `binslib/scripts/import.ts` | Scans for MTC `.txt` chapters + metadata (being deleted) |
| `binslib/scripts/pre-compress.ts` | Reads `.txt` to build bundles (being deleted) |
| `binslib/scripts/audit.ts` | Cross-refs crawler output vs bundles (being deleted) |
| `binslib/scripts/is-safe-to-delete.ts` | Verifies `.txt` source exists (being deleted) |
| `binslib/scripts/pull-covers.ts` | Reads `metadata.json` for poster URLs (being deleted) |
| `binslib/scripts/test-export-book.ts` | Reads `.txt` for test compression (being deleted) |
| `crawler-descryptor/fetch_catalog.py` | `OUTPUT_DIR = ../crawler/output` (moving to book-ingest) |

After cleanup, **only these remain** as consumers of `crawler/output/`:
- `meta-puller/pull_metadata.py` — scans book dirs, writes `metadata.json` + `cover.jpg`
- `epub-converter/` — reads `.txt` chapters + metadata for EPUB generation
- `binslib/docker-compose.yml` — mounts for the import cron (can be removed once import.ts is gone)

**Verdict**: **Keep `crawler/output/`** (data). Delete `crawler/zstd-benchmark/` (standalone benchmark, not referenced anywhere). The `.txt` chapter files will become fully redundant once epub-converter is updated to read from bundles — but that is a future phase.

---

### 2. `crawler-descryptor/` — ✅ Safe to delete WITH prep work

Most code is superseded by `book-ingest`, which has its own copies of the API client, decryption, and download logic. However, there are **four dependencies** that must be resolved first.

#### Dependency A: `src/decrypt.py` symlink (CRITICAL)

```
book-ingest/src/decrypt.py -> ../../crawler-descryptor/src/decrypt.py
```

`book-ingest` uses a **symlink** to the decryption module. Deleting `crawler-descryptor/` would break `book-ingest` entirely.

**Fix**: Replace the symlink with a real file copy.

```bash
rm book-ingest/src/decrypt.py
cp crawler-descryptor/src/decrypt.py book-ingest/src/decrypt.py
```

#### Dependency B: `fresh_books_download.json` (plan file)

```python
# book-ingest/ingest.py line 67
DEFAULT_PLAN = SCRIPT_DIR.parent / "crawler-descryptor" / "fresh_books_download.json"
```

`book-ingest` defaults to reading its plan from `crawler-descryptor/`.

**Fix**: Move the plan file and update the default path.

```bash
mkdir -p book-ingest/data
mv crawler-descryptor/fresh_books_download.json book-ingest/data/
```

```python
# book-ingest/ingest.py — update DEFAULT_PLAN
DEFAULT_PLAN = SCRIPT_DIR / "data" / "fresh_books_download.json"
```

#### Dependency C: `fetch_catalog.py` (plan generator)

`fetch_catalog.py` is the **only** tool that generates `fresh_books_download.json`. It paginates the API catalog, cross-references with local data (crawler output + bundles), and outputs the plan. `book-ingest` does not have this capability.

**Fix**: Move `fetch_catalog.py` into `book-ingest/` and adapt its imports.

Files to move:
- `crawler-descryptor/fetch_catalog.py` → `book-ingest/fetch_catalog.py`
- `crawler-descryptor/src/utils.py` → `book-ingest/src/utils.py` (used by `fetch_catalog.py` for `count_existing_chapters`, `read_bundle_indices`)

Update imports in the moved `fetch_catalog.py`:
- Replace `from config import BASE_URL, HEADERS` with imports from `src.api`
- Replace `from src.utils import count_existing_chapters` (path is now local, just works)
- Update `OUTPUT_DIR` to point to `../crawler/output`
- Update `CATALOG_FILE` and plan output paths to `data/`

#### Dependency D: `meta-puller/pull_metadata.py` config import

```python
# meta-puller/pull_metadata.py line 38
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "crawler"))
from config import BASE_URL, HEADERS, REQUEST_DELAY
```

This is **already broken** — it points to `../crawler/` but the config lives in `../crawler-descryptor/`. We've been working around it with `PYTHONPATH="../crawler-descryptor"`.

**Fix**: Give `meta-puller` its own inline config (3 constants) instead of importing from another subproject.

```python
# meta-puller/pull_metadata.py — replace sys.path hack with inline config
import os

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
```

#### What gets deleted

After the prep work, everything remaining in `crawler-descryptor/` is superseded:

| File | Superseded by |
|------|---------------|
| `config.py` | `book-ingest/src/api.py` inline constants + `meta-puller` inline |
| `main.py` | `book-ingest/ingest.py` (single book) |
| `download_batch.py` | `book-ingest/ingest.py -w N` |
| `download_topN.py` | `book-ingest/ingest.py --plan ...` |
| `collect_samples.py` | One-time analysis tool, no longer needed |
| `src/client.py` | `book-ingest/src/api.py` `AsyncBookClient` |
| `src/downloader.py` | `book-ingest/src/api.py` |
| `src/decrypt.py` | Copied into `book-ingest/src/decrypt.py` |
| `src/iv_extract.py` | One-time analysis tool |
| `src/utils.py` | Moved to `book-ingest/src/utils.py` |
| `fetch_catalog.py` | Moved to `book-ingest/fetch_catalog.py` |
| `frida/` | Reverse-engineering tools, historical only |
| `tests/` | Tests for the old client |
| `API.md`, `ENCRYPTION.md`, `KNOWLEDGE.md` | Archive to `plan/archive/` |

**Verdict**: Safe to delete **after** completing all four prep steps.

---

### 3. `crawler-emulator/` — ✅ Safe to delete immediately

The emulator-based crawler is the original approach, deprecated since `crawler-descryptor` and now fully replaced by `book-ingest`.

**Dependencies**: Zero. No other subproject imports from, symlinks to, or references `crawler-emulator/`.

**Contents**: `grab_book.py`, `parallel_grab.py`, `batch_grab.py`, `extract_book.py`, `start_emulators.sh`, `config.py`, `progress-checking/`, docs, APK directory.

**Verdict**: **Safe to delete immediately**. No prep work needed. The README already marks it as `[DEPRECATED]`.

---

### 4. `binslib/scripts/` — mostly deletable

With `book-ingest` handling the full MTC pipeline (download → decrypt → compress → bundle → DB) and TTV not being a factor, most scripts are superseded.

| Script | Status | Reason |
|--------|--------|--------|
| `migrate.ts` | **KEEP** | Essential — runs Drizzle migrations + FTS5 table creation. No replacement. |
| `warmup-cache.js` | **KEEP** | Production deployment utility — warms OS page cache for SQLite. Unrelated to import pipeline. |
| `import.ts` | **DELETE** | Superseded by `book-ingest/ingest.py` for MTC. Was only kept for TTV import, which is not a concern now. |
| `pre-compress.ts` | **DELETE** | Superseded — `book-ingest` compresses inline. Was only kept for TTV `.txt` → bundle conversion. |
| `audit.ts` | **DELETE** | `book-ingest --audit-only` provides equivalent catalog-vs-local audit for MTC. |
| `is-safe-to-delete.ts` | **DELETE** | Useful concept but tightly coupled to `import.ts` workflow. Can be recreated if needed when cleaning up `.txt` files. |
| `pull-covers.ts` | **DELETE** | Fully superseded by `meta-puller/pull_metadata.py --cover-only`. |
| `test-export-book.ts` | **DELETE** | One-time test script for zstd compression. Not part of any workflow. |

**Verdict**: Keep `migrate.ts` and `warmup-cache.js`. Delete the other six scripts.

Also remove the now-unused npm scripts from `binslib/package.json`:

```diff
- "import": "tsx scripts/import.ts",
- "import:full": "tsx scripts/import.ts --full",
- "import:cron": "tsx scripts/import.ts --cron",
- "pre-compress": "tsx scripts/pre-compress.ts"
```

And remove `cli-progress` from dependencies (only used by `import.ts`, `pre-compress.ts`, `pull-covers.ts`):

```diff
- "cli-progress": "^3.12.0",
...
- "@types/cli-progress": "^3.11.6",
```

---

## Execution Plan

### Phase 1: Immediate deletions (zero risk)

```bash
# Delete deprecated emulator crawler
rm -rf crawler-emulator/

# Delete standalone benchmark (not referenced)
rm -rf crawler/zstd-benchmark/

# Delete superseded binslib scripts
rm binslib/scripts/pull-covers.ts
rm binslib/scripts/test-export-book.ts
rm binslib/scripts/import.ts
rm binslib/scripts/pre-compress.ts
rm binslib/scripts/audit.ts
rm binslib/scripts/is-safe-to-delete.ts
```

Update `binslib/package.json`: remove `import`, `import:full`, `import:cron`, `pre-compress` scripts and the `cli-progress` / `@types/cli-progress` dependencies.

### Phase 2: Migrate dependencies out of `crawler-descryptor/`

**Step 2a** — Break the decrypt.py symlink:

```bash
rm book-ingest/src/decrypt.py
cp crawler-descryptor/src/decrypt.py book-ingest/src/decrypt.py
```

**Step 2b** — Move fetch_catalog.py + utils.py into book-ingest:

```bash
cp crawler-descryptor/fetch_catalog.py book-ingest/fetch_catalog.py
cp crawler-descryptor/src/utils.py book-ingest/src/utils.py
```

Then edit `book-ingest/fetch_catalog.py`:
- Replace `from config import BASE_URL, HEADERS` with imports from `src.api`
- Replace `from src.utils import count_existing_chapters` (path now local)
- Update `OUTPUT_DIR` to point to `../crawler/output`
- Update `CATALOG_FILE` and plan output paths to `data/`

**Step 2c** — Move plan file + update default path:

```bash
mkdir -p book-ingest/data
mv crawler-descryptor/fresh_books_download.json book-ingest/data/
```

Edit `book-ingest/ingest.py` line 67:

```python
DEFAULT_PLAN = SCRIPT_DIR / "data" / "fresh_books_download.json"
```

**Step 2d** — Inline config in meta-puller:

Edit `meta-puller/pull_metadata.py`:
- Remove `sys.path.insert(0, ...)` and `from config import ...`
- Add inline `BASE_URL`, `HEADERS`, `REQUEST_DELAY` constants
- This also fixes the existing broken import path (`../crawler` → should be `../crawler-descryptor`)

**Step 2e** — Archive docs:

```bash
mkdir -p plan/archive/crawler-descryptor
cp crawler-descryptor/API.md plan/archive/crawler-descryptor/
cp crawler-descryptor/ENCRYPTION.md plan/archive/crawler-descryptor/
cp crawler-descryptor/KNOWLEDGE.md plan/archive/crawler-descryptor/
```

### Phase 3: Verify and delete `crawler-descryptor/`

```bash
# Verify book-ingest still works without crawler-descryptor
cd book-ingest
python3 -c "from src.decrypt import decrypt_content; print('decrypt OK')"
python3 -c "from src.utils import count_existing_chapters; print('utils OK')"
python3 ingest.py --dry-run 100358

# Verify meta-puller works standalone
cd ../meta-puller
python3 pull_metadata.py --dry-run --ids 100358

# Verify fetch_catalog imports work
cd ../book-ingest
python3 -c "import fetch_catalog; print('catalog OK')"

# If all pass, delete
rm -rf crawler-descryptor/
```

### Phase 4: Update docs and references

- Update `README.md` architecture diagram: remove `crawler/` and `crawler-descryptor/` from crawler layer, mark `crawler-emulator/` as removed
- Update `README.md` subprojects table: remove deleted entries, update `binslib/` description
- Update `README.md` quick start: remove `crawler-descryptor` examples, remove `npm run import` / `npm run db:migrate` steps (DB is managed by `book-ingest` now)
- Update `binslib/README.md`: remove import/pre-compress documentation sections, update npm scripts table
- Clean up `binslib/docker-compose.yml`: remove `../crawler/output` volume mount and `CRAWLER_OUTPUT_DIR` / `TTV_CRAWLER_OUTPUT_DIR` env vars (no import script to consume them)

---

## Dependency Graph (after cleanup)

```
book-ingest/                    ← primary MTC pipeline
  ├── fetch_catalog.py          ← moved from crawler-descryptor
  ├── ingest.py                 ← reads plan from data/
  ├── migrate_v2.py             ← bundle v1→v2 migration
  ├── data/
  │   └── fresh_books_download.json
  └── src/
      ├── api.py                ← self-contained (own config + client)
      ├── decrypt.py            ← real file (was symlink)
      ├── utils.py              ← moved from crawler-descryptor/src
      ├── bundle.py
      ├── compress.py
      ├── cover.py
      └── db.py

meta-puller/                    ← cover + metadata fetcher
  └── pull_metadata.py          ← self-contained (inline config)

sync-book/                      ← file sync across machines
  └── sync-bundles.sh           ← bundles + covers

crawler/output/                 ← data only, no code
  └── {book_id}/                   (metadata.json, cover.jpg, *.txt)

crawler-tangthuvien/            ← kept as-is (dormant)
  └── output/{book_id}/

binslib/
  ├── scripts/
  │   ├── migrate.ts            ← kept (essential)
  │   └── warmup-cache.js       ← kept (production)
  └── src/                      ← Next.js web reader

epub-converter/                 ← reads crawler/output/ (data only)
```

---

## Summary

| Target | Action | Risk | Prep needed |
|--------|--------|------|-------------|
| `crawler-emulator/` | **Delete** | None | No |
| `crawler/zstd-benchmark/` | **Delete** | None | No |
| `binslib/scripts/import.ts` | **Delete** | None | Remove npm scripts + `cli-progress` dep |
| `binslib/scripts/pre-compress.ts` | **Delete** | None | (same package.json cleanup) |
| `binslib/scripts/audit.ts` | **Delete** | None | No |
| `binslib/scripts/is-safe-to-delete.ts` | **Delete** | None | No |
| `binslib/scripts/pull-covers.ts` | **Delete** | None | No |
| `binslib/scripts/test-export-book.ts` | **Delete** | None | No |
| `crawler-descryptor/` | **Delete** | Low | Break symlink, move 3 files, inline config |
| `crawler/output/*.txt` | **NOT this plan** | High | Needs epub-converter bundle support first |

**Total files/dirs deleted**: 3 directories + 6 scripts + 1 full subproject (after migration)
**Files moved**: `decrypt.py` (copy), `fetch_catalog.py`, `utils.py`, `fresh_books_download.json`, 3 doc files archived
**Files edited**: `book-ingest/ingest.py` (1 path), `meta-puller/pull_metadata.py` (inline config), `book-ingest/fetch_catalog.py` (imports), `binslib/package.json` (remove scripts + dep)