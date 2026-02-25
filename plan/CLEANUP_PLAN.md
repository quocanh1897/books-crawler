# Cleanup Plan

Audit of what can be safely deleted now that `book-ingest` is the primary pipeline for MTC books.

TTV (`crawler-tangthuvien/`) is kept as-is but is **not a factor** in deletion decisions — it is dormant and should not block cleanup of MTC tooling.

## Current Workflow

| Task | Tool | Notes |
|------|------|-------|
| Update download plan | `meta-puller/pull_metadata.py --meta-only` | ✅ Refactored — paginates API, cross-refs bundles, writes `book-ingest/data/fresh_books_download.json` |
| Download + decrypt + compress + DB | `book-ingest/ingest.py` | Reads plan from `data/fresh_books_download.json` (✅ path updated) |
| Pull covers | `meta-puller/pull_metadata.py --cover-only` | ✅ Refactored — discovers from bundles, downloads to `binslib/public/covers/` |
| Sync files across machines | `sync-book/sync-bundles.sh` | Bundles + covers via rsync |
| EPUB generation | `epub-converter/convert.py` | ✅ Refactored — reads bundles + DB, caches in `binslib/data/epub/` |
| DB migrations | `binslib/scripts/migrate.ts` | Drizzle + FTS5 setup |

---

## Completed Work (this branch)

The following refactors have already been committed on the `cleanup` branch. They remove `crawler/output/` as a runtime dependency from the two tools that still referenced it.

### ✅ meta-puller/pull_metadata.py — refactored

- Removed all `crawler/output/` dependency; discovers books from `binslib/data/compressed/*.bundle`
- Added `--meta-only`: paginate API catalog, cross-ref with bundle chapter counts, write plan to `book-ingest/data/fresh_books_download.json`
- `--cover-only`: discovers from bundles, downloads covers via API
- Default (no flags): both phases
- Inlined API config — fixed the broken `sys.path` import from `../crawler`
- Absorbed `fetch_catalog.py` audit/plan-generation logic into `generate_plan()`

### ✅ epub-converter/ — refactored

- Reads chapters from BLIB bundle files via `BundleReader` (zstd + global dict)
- Reads metadata from `binslib/data/binslib.db` (SQLite)
- Reads covers from `binslib/public/covers/{book_id}.jpg`
- Caches EPUBs as `binslib/data/epub/{book_id}_{chapter_count}.epub`
- Cache-aware: skips when cached chapter count ≥ bundle count
- Removed AUDIT.md integration, meta-puller subprocess, all crawler/output refs
- Replaced `httpx` dependency with `pyzstd`

### ✅ book-ingest/ingest.py — DEFAULT_PLAN updated

- `DEFAULT_PLAN` changed from `crawler-descryptor/fresh_books_download.json` → `book-ingest/data/fresh_books_download.json`
- Plan file copied to new location

### ✅ binslib API routes — updated

- `download/route.ts`, `download-status/route.ts`, `epub/route.ts`: all updated
- `EPUB_OUTPUT_DIR` (subdirectory per book) → `EPUB_CACHE_DIR` (flat `data/epub/`)
- `findEpub()` → `findCachedEpub()` with `{book_id}_{count}.epub` pattern
- Cache freshness: compares cached chapter count vs DB chapter count
- `download-status` response now includes `epub_chapter_count` + `db_chapter_count`

---

## Phase 0: Verify completed refactors

Before proceeding with deletions, verify the refactored code works end-to-end.

### Tests

```bash
# ── meta-puller ──────────────────────────────────────────────────────────
cd meta-puller

# T0.1: verify --meta-only can reach the API and scan bundles (dry-run)
python3 pull_metadata.py --meta-only --dry-run
# Expected: prints catalog audit table, "Dry run — plan file not written."

# T0.2: verify --cover-only discovers books from bundles
python3 pull_metadata.py --cover-only --dry-run --ids 100358
# Expected: prints "Books found: N", "Targeted: 1", "Missing covers: 0 or 1"

# T0.3: verify default mode (meta + covers) dry-run
python3 pull_metadata.py --dry-run
# Expected: catalog audit table, then cover pull summary

# T0.4: actually run --meta-only and check the plan file is written
python3 pull_metadata.py --meta-only
ls -la ../book-ingest/data/fresh_books_download.json
# Expected: file exists with recent timestamp

# ── epub-converter ───────────────────────────────────────────────────────
cd ../epub-converter

# T0.5: verify bundle scanning + DB metadata reading
python3 convert.py --list | head -30
# Expected: table with ID, Name, Chaps, Status, Cover, Cached, Action columns

# T0.6: convert a single book end-to-end
python3 convert.py --ids 100358
# Expected: "1 converted" in summary; file exists at binslib/data/epub/100358_*.epub
ls ../binslib/data/epub/100358_*.epub

# T0.7: verify cache hit on re-run
python3 convert.py --ids 100358
# Expected: "1 cached" (not "1 converted")

# T0.8: verify --force bypasses cache
python3 convert.py --ids 100358 --force
# Expected: "1 converted" (regenerated despite cache)

# ── book-ingest ──────────────────────────────────────────────────────────
cd ../book-ingest

# T0.9: verify plan file is found at new path
python3 ingest.py --dry-run 100358
# Expected: no "plan file not found" error; shows dry-run output

# ── binslib ──────────────────────────────────────────────────────────────
cd ../binslib

# T0.10: verify dev server starts
npm run dev &
sleep 5

# T0.11: verify EPUB download-status endpoint works with new cache format
curl -s http://localhost:3000/api/books/100358/download-status | python3 -m json.tool
# Expected: JSON with epub_exists, epub_chapter_count, db_chapter_count fields

# T0.12: verify EPUB serve endpoint
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/books/100358/epub
# Expected: 200 (if T0.6 created the cached epub) or 404

kill %1  # stop dev server
```

**Gate**: All T0.x tests must pass before proceeding to Phase 1.

---

## Dependency Audit

### 1. `crawler/` — data directory, code can go

No crawler code remains (moved to `crawler-emulator/` long ago). Purely a **data mount point**: `crawler/output/` holds 30,354 book directories with `.txt` chapters, `metadata.json`, and `cover.jpg`.

**After the refactors above, `crawler/output/` is referenced only by:**

| File | How | Status |
|------|-----|--------|
| `binslib/docker-compose.yml` | Volume mount `../crawler/output:/data/crawler-output` | Remove in Phase 4 |

All former consumers have been migrated:
- `meta-puller` → now reads from bundles ✅
- `epub-converter` → now reads from bundles + DB ✅
- `binslib/scripts/import.ts` → being deleted in Phase 1
- `binslib/scripts/pre-compress.ts` → being deleted in Phase 1
- `binslib/scripts/audit.ts` → being deleted in Phase 1
- `binslib/scripts/is-safe-to-delete.ts` → being deleted in Phase 1
- `binslib/scripts/pull-covers.ts` → being deleted in Phase 1
- `binslib/scripts/test-export-book.ts` → being deleted in Phase 1
- `crawler-descryptor/fetch_catalog.py` → absorbed into meta-puller ✅

**Verdict**: **Keep `crawler/output/`** (data, needed for potential future TTV revival). Delete `crawler/zstd-benchmark/` (standalone, unreferenced). The docker-compose mount is cleaned up in Phase 4.

---

### 2. `crawler-descryptor/` — ✅ safe to delete WITH prep work

Most code is superseded by `book-ingest`. The meta-puller config (Dependency D) and plan path (Dependency B) are already resolved. Two dependencies remain.

#### Dependency A: `src/decrypt.py` symlink (CRITICAL)

```
book-ingest/src/decrypt.py -> ../../crawler-descryptor/src/decrypt.py
```

**Fix**: Replace the symlink with a real file copy.

#### ~~Dependency B: `fresh_books_download.json`~~ ✅ Done

Plan file moved to `book-ingest/data/`. `DEFAULT_PLAN` updated in `ingest.py`.

#### Dependency C: `fetch_catalog.py` (plan generator)

`meta-puller --meta-only` now provides this functionality. The original `fetch_catalog.py` is no longer needed as a runtime tool. However, `src/utils.py` (used by `fetch_catalog.py`) contains `count_existing_chapters()` and `read_bundle_indices()` which could be useful in `book-ingest`. Move for posterity.

#### ~~Dependency D: `meta-puller/pull_metadata.py` config import~~ ✅ Done

Config inlined in the refactored `pull_metadata.py`.

**Verdict**: Safe to delete after Phase 2 prep (break symlink, archive docs). Risk: low.

---

### 3. `crawler-emulator/` — ✅ safe to delete immediately

Zero dependencies. Deprecated. README marks it as `[DEPRECATED]`.

---

### 4. `binslib/scripts/` — mostly deletable

| Script | Status | Reason |
|--------|--------|--------|
| `migrate.ts` | **KEEP** | Essential — Drizzle migrations + FTS5 tables. No replacement. |
| `warmup-cache.js` | **KEEP** | Production cache warmup. Unrelated to import pipeline. |
| `import.ts` | **DELETE** | Superseded by `book-ingest/ingest.py`. |
| `pre-compress.ts` | **DELETE** | Superseded — `book-ingest` compresses inline. |
| `audit.ts` | **DELETE** | `book-ingest --audit-only` + `meta-puller --meta-only` cover this. |
| `is-safe-to-delete.ts` | **DELETE** | Tightly coupled to import.ts workflow. |
| `pull-covers.ts` | **DELETE** | Superseded by `meta-puller --cover-only`. |
| `test-export-book.ts` | **DELETE** | One-time test script. |

Also clean up `binslib/package.json`:
- Remove npm scripts: `import`, `import:full`, `import:cron`, `pre-compress`
- Remove deps: `cli-progress`, `@types/cli-progress`

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

Update `binslib/package.json`:
- Remove scripts: `import`, `import:full`, `import:cron`, `pre-compress`
- Remove dependencies: `cli-progress`, `chalk`
- Remove devDependencies: `@types/cli-progress`

#### Phase 1 Tests

```bash
# T1.1: verify binslib builds without deleted scripts
cd binslib && npm run build
# Expected: build succeeds (no broken imports from deleted scripts)

# T1.2: verify dev server starts
npm run dev &
sleep 5
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
# Expected: 200
kill %1

# T1.3: verify remaining scripts still work
npx tsx scripts/migrate.ts
# Expected: "Migrations complete."

# T1.4: verify warmup-cache still runs
node scripts/warmup-cache.js
# Expected: "Cache warmed in X.Xs"

# T1.5: verify book-ingest is unaffected
cd ../book-ingest && python3 ingest.py --dry-run 100358
# Expected: dry-run output, no errors

# T1.6: verify meta-puller is unaffected
cd ../meta-puller && python3 pull_metadata.py --dry-run
# Expected: catalog audit + cover summary

# T1.7: verify epub-converter is unaffected
cd ../epub-converter && python3 convert.py --dry-run --ids 100358
# Expected: dry-run output showing conversion plan
```

**Gate**: All T1.x tests pass → commit Phase 1.

---

### Phase 2: Migrate dependencies out of `crawler-descryptor/`

**Step 2a** — Break the `decrypt.py` symlink:

```bash
rm book-ingest/src/decrypt.py
cp crawler-descryptor/src/decrypt.py book-ingest/src/decrypt.py
```

##### Step 2a Tests

```bash
# T2a.1: verify decrypt module imports
cd book-ingest
python3 -c "from src.decrypt import decrypt_content, DecryptionError; print('decrypt OK')"
# Expected: "decrypt OK"

# T2a.2: verify file is a real file, not a symlink
file src/decrypt.py
# Expected: "Python script text executable" (NOT "symbolic link")

# T2a.3: verify ingest still works
python3 ingest.py --dry-run 100358
# Expected: dry-run output, no import errors
```

**Step 2b** — Move `fetch_catalog.py` + `utils.py` into `book-ingest` (for archival / future use):

```bash
cp crawler-descryptor/fetch_catalog.py book-ingest/fetch_catalog.py
cp crawler-descryptor/src/utils.py book-ingest/src/utils.py
```

Edit `book-ingest/fetch_catalog.py`:
- Replace `from config import BASE_URL, HEADERS` → import from `src.api`
- `from src.utils import count_existing_chapters` (path is local now)
- Update `OUTPUT_DIR` → `../crawler/output`
- Update `CATALOG_FILE` and plan output paths → `data/`

##### Step 2b Tests

```bash
# T2b.1: verify utils module imports
cd book-ingest
python3 -c "from src.utils import count_existing_chapters, read_bundle_indices; print('utils OK')"
# Expected: "utils OK"

# T2b.2: verify fetch_catalog imports
python3 -c "import fetch_catalog; print('catalog OK')"
# Expected: "catalog OK"

# T2b.3: verify fetch_catalog dry-run (uses --skip-fetch if catalog exists)
python3 fetch_catalog.py --skip-fetch 2>/dev/null || echo "SKIP: no existing catalog"
# Expected: either audit output or the skip message
```

**Step 2c** — ~~Move plan file + update DEFAULT_PLAN~~ ✅ Already done.

**Step 2d** — ~~Inline config in meta-puller~~ ✅ Already done.

**Step 2e** — Archive docs:

```bash
mkdir -p plan/archive/crawler-descryptor
cp crawler-descryptor/API.md plan/archive/crawler-descryptor/
cp crawler-descryptor/ENCRYPTION.md plan/archive/crawler-descryptor/
cp crawler-descryptor/KNOWLEDGE.md plan/archive/crawler-descryptor/
cp crawler-descryptor/PLAN.md plan/archive/crawler-descryptor/
cp crawler-descryptor/README.md plan/archive/crawler-descryptor/
```

##### Step 2e Tests

```bash
# T2e.1: verify archived docs exist
ls plan/archive/crawler-descryptor/
# Expected: API.md ENCRYPTION.md KNOWLEDGE.md PLAN.md README.md
```

**Gate**: All T2x tests pass → commit Phase 2.

---

### Phase 3: Delete `crawler-descryptor/`

```bash
rm -rf crawler-descryptor/
```

#### Phase 3 Tests (full integration)

```bash
# ── book-ingest (primary pipeline) ───────────────────────────────────────
cd book-ingest

# T3.1: decrypt module loads
python3 -c "from src.decrypt import decrypt_content; print('decrypt OK')"

# T3.2: utils module loads
python3 -c "from src.utils import count_existing_chapters; print('utils OK')"

# T3.3: ingest dry-run with explicit book IDs
python3 ingest.py --dry-run 100358 100441
# Expected: shows 2 books in dry-run output, no import errors

# T3.4: ingest dry-run from plan file (default path)
python3 ingest.py --dry-run --limit 3
# Expected: shows 3 entries from fresh_books_download.json

# T3.5: audit mode
python3 ingest.py --audit-only --limit 5
# Expected: audit output for 5 books, no crashes

# ── meta-puller ──────────────────────────────────────────────────────────
cd ../meta-puller

# T3.6: meta-only dry-run (no external deps needed)
python3 pull_metadata.py --meta-only --dry-run
# Expected: catalog audit table

# T3.7: cover-only dry-run
python3 pull_metadata.py --cover-only --dry-run --ids 100358
# Expected: cover pull summary

# T3.8: full dry-run
python3 pull_metadata.py --dry-run
# Expected: both phases

# ── epub-converter ───────────────────────────────────────────────────────
cd ../epub-converter

# T3.9: list mode (reads bundles + DB)
python3 convert.py --list | head -20
# Expected: table output, no errors

# T3.10: dry-run conversion
python3 convert.py --dry-run --ids 100358
# Expected: shows conversion plan

# T3.11: actual conversion (verifies full zstd decompression pipeline)
python3 convert.py --ids 100358 --force
# Expected: "1 converted" in summary
ls ../binslib/data/epub/100358_*.epub
# Expected: file exists

# ── binslib ──────────────────────────────────────────────────────────────
cd ../binslib

# T3.12: production build
npm run build
# Expected: build succeeds

# T3.13: dev server + EPUB API smoke test
npm run dev &
sleep 5

curl -s http://localhost:3000/api/books/100358/download-status | python3 -m json.tool
# Expected: JSON with epub_exists: true, correct chapter counts

curl -s -o /tmp/test.epub http://localhost:3000/api/books/100358/epub
file /tmp/test.epub
# Expected: "Zip archive data" (EPUB is a zip)
rm /tmp/test.epub

kill %1

# ── sync-book ────────────────────────────────────────────────────────────

# T3.14: verify sync script still parses args
bash sync-book/sync-bundles.sh --help
# Expected: usage text, no errors

# ── no dangling references ───────────────────────────────────────────────

# T3.15: grep for any remaining references to deleted directory
grep -r "crawler-descryptor" --include="*.py" --include="*.ts" --include="*.js" \
  --include="*.json" --include="*.yml" --include="*.md" \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git \
  --exclude-dir=plan/archive . | grep -v "CLEANUP_PLAN\|CHANGELOG\|CHECKPOINT"
# Expected: no output (zero references outside archive/changelog)
```

**Gate**: All T3.x tests pass → commit Phase 3.

---

### Phase 4: Update docs and references

- Update `README.md`:
  - Architecture diagram: remove `crawler/` and `crawler-descryptor/` from crawler layer
  - Subprojects table: remove `crawler/`, `crawler-descryptor/`, `crawler-emulator/` entries; update `binslib/` and `meta-puller/` descriptions
  - Quick start: replace `crawler-descryptor` examples with `book-ingest` + `meta-puller` workflow; remove `npm run import` / `npm run db:migrate` binslib steps
- Update `binslib/README.md`:
  - Remove import, pre-compress, and audit documentation sections
  - Update npm scripts table (only `dev`, `build`, `start`, `lint`, `db:generate`, `db:migrate`, `db:studio`)
  - Remove environment variables for `CRAWLER_OUTPUT_DIR`, `TTV_CRAWLER_OUTPUT_DIR`, `META_PULLER_DIR`
- Clean up `binslib/docker-compose.yml`:
  - Remove `../crawler/output` volume mount
  - Remove `CRAWLER_OUTPUT_DIR`, `TTV_CRAWLER_OUTPUT_DIR` env vars
  - Update `EPUB_OUTPUT_DIR` → `EPUB_CACHE_DIR` (or remove if the default is correct)
- Update `meta-puller/CONTEXT.md` to reflect the refactored workflow

#### Phase 4 Tests

```bash
# T4.1: verify README renders (check no broken mermaid or table syntax)
# Manual review of README.md in a markdown viewer

# T4.2: verify binslib build after doc/config changes
cd binslib && npm run build
# Expected: build succeeds

# T4.3: validate docker-compose syntax
cd binslib && docker compose config > /dev/null 2>&1 && echo "OK" || echo "FAIL"
# Expected: OK

cd ../epub-converter && docker compose config > /dev/null 2>&1 && echo "OK" || echo "FAIL"
# Expected: OK

# T4.4: no remaining references to deleted dirs (excluding plan/archive and changelogs)
grep -rn "crawler-emulator\|crawler-descryptor\|crawler/output\|epub-output" \
  --include="*.py" --include="*.ts" --include="*.js" --include="*.yml" \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git \
  --exclude-dir=plan/archive . | grep -v "CLEANUP_PLAN\|CHANGELOG\|CHECKPOINT"
# Expected: no output (zero stale references)

# T4.5: full end-to-end smoke test
cd ../meta-puller && python3 pull_metadata.py --meta-only --dry-run
cd ../book-ingest && python3 ingest.py --dry-run --limit 2
cd ../epub-converter && python3 convert.py --dry-run --ids 100358
cd ../binslib && npm run dev &
sleep 5
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
kill %1
# Expected: all succeed
```

**Gate**: All T4.x tests pass → commit Phase 4, merge `cleanup` → `main`, tag.

---

## Dependency Graph (after cleanup)

```
book-ingest/                    ← primary MTC pipeline
  ├── fetch_catalog.py          ← moved from crawler-descryptor (archival)
  ├── ingest.py                 ← reads plan from data/
  ├── migrate_v2.py             ← bundle v1→v2 migration
  ├── data/
  │   └── fresh_books_download.json  ← written by meta-puller --meta-only
  └── src/
      ├── api.py                ← self-contained (own config + client)
      ├── decrypt.py            ← real file (was symlink to crawler-descryptor)
      ├── utils.py              ← moved from crawler-descryptor/src
      ├── bundle.py
      ├── compress.py
      ├── cover.py
      └── db.py

meta-puller/                    ← catalog + cover fetcher
  └── pull_metadata.py          ← self-contained (inline config)
                                   --meta-only → book-ingest/data/fresh_books_download.json
                                   --cover-only → binslib/public/covers/

sync-book/                      ← file sync across machines
  └── sync-bundles.sh           ← bundles + covers via rsync

crawler/output/                 ← data only, no code, no active consumers
  └── {book_id}/                   (metadata.json, cover.jpg, *.txt)

crawler-tangthuvien/            ← kept as-is (dormant)
  └── output/{book_id}/

binslib/
  ├── data/
  │   ├── binslib.db            ← SQLite (metadata, chapters, FTS5)
  │   ├── compressed/*.bundle   ← per-book chapter bundles
  │   ├── epub/*.epub           ← cached EPUBs ({id}_{count}.epub)
  │   └── global.dict           ← zstd dictionary
  ├── public/covers/            ← {book_id}.jpg cover images
  ├── scripts/
  │   ├── migrate.ts            ← kept (essential)
  │   └── warmup-cache.js       ← kept (production)
  └── src/                      ← Next.js web reader + API routes

epub-converter/                 ← reads bundles + DB + covers (no crawler/output)
  ├── convert.py                ← CLI entry point
  └── epub_builder.py           ← BundleReader + EPUB builder
```

---

## Summary

| Target | Phase | Action | Risk | Prep | Status |
|--------|-------|--------|------|------|--------|
| meta-puller refactor | 0 | **Refactor** | — | — | ✅ Done |
| epub-converter refactor | 0 | **Refactor** | — | — | ✅ Done |
| book-ingest DEFAULT_PLAN | 0 | **Update** | — | — | ✅ Done |
| binslib API routes | 0 | **Update** | — | — | ✅ Done |
| `crawler-emulator/` | 1 | **Delete** | None | No | ⬜ TODO |
| `crawler/zstd-benchmark/` | 1 | **Delete** | None | No | ⬜ TODO |
| `binslib/scripts/` (6 files) | 1 | **Delete** | None | Update package.json | ⬜ TODO |
| `decrypt.py` symlink | 2a | **Copy** | Low | Verify import | ⬜ TODO |
| `fetch_catalog.py` + `utils.py` | 2b | **Move** | Low | Update imports | ⬜ TODO |
| Archive docs | 2e | **Copy** | None | No | ⬜ TODO |
| `crawler-descryptor/` | 3 | **Delete** | Low | Phases 2a–2e done | ⬜ TODO |
| README + docs + docker | 4 | **Update** | None | No | ⬜ TODO |
| `crawler/output/*.txt` | — | **NOT this plan** | High | Needs TTV decision first | ⬜ Future |

**Total remaining work**: 3 directories deleted + 6 scripts deleted + 1 subproject deleted (after migration) + docs update

**Test count**: 15 gate tests across 4 phases (T0: 12, T1: 7, T2: 6, T3: 15, T4: 5 = **45 total**)