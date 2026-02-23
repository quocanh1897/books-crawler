# Refactoring Plan — Download, Pre-compress & Import Pipeline

## Goal

1. Reduce code duplication between `download_top1000.py` and `batch_download.py`
2. Make the download flow bundle-aware (skip chapters already compressed in `binslib/data/compressed/`)
3. Make pre-compress and import incremental (only process new chapters, validate continuity)
4. Aggregate and surface gap/continuity errors clearly

---

## Part A — crawler-descryptor: Consolidate download scripts

### A1. Create `src/downloader.py` — shared async download engine

Extract duplicated code from `download_top1000.py` and `batch_download.py` into a single shared module.

**What moves into `src/downloader.py`:**

| Symbol | Source | Notes |
|--------|--------|-------|
| `AsyncBookClient` | Both files (copy-pasted) | Parameterize `max_concurrent` and `request_delay` via constructor args. Currently hardcoded differently: 180/0.015 in `download_top1000.py` vs 8/0.3 in `batch_download.py`. Each caller passes its own defaults. |
| `download_book()` | Both files (diverged signatures) | Unified signature: `download_book(client, book_entry, label)`. Accepts a `book_entry` dict. If `first_chapter` is missing from the entry, fetches metadata first (covering `batch_download.py`'s use case). If present, uses it directly (covering `download_top1000.py`'s plan-file use case). |

**Rename:** `batch_download.py` → `download_batch.py`

### A2. Update `src/utils.py` — bundle-aware chapter counting

| Change | Detail |
|--------|--------|
| Add `BINSLIB_COMPRESSED_DIR` | Path constant: `../../binslib/data/compressed/` (relative to `src/`) |
| Add `read_bundle_indices(book_id) → set[int]` | Reads the BLIB binary header + index section from `{book_id}.bundle`. Parses magic (4) + version (4) + count (4) + N × 16-byte entries. Returns set of chapter index numbers. Returns empty set if bundle doesn't exist or is invalid. |
| Update `count_existing_chapters(book_id) → set[int]` | Returns the **union** of `.txt` file indices (existing behavior) AND bundle indices (new). A chapter is "done" if it exists in either form. |

**BLIB header format reminder** (must match `chapter-storage.ts` and `pre-compress.ts`):

```
Offset  Size  Field
0       4     Magic "BLIB"
4       4     uint32 LE: version (1)
8       4     uint32 LE: entry count N
12      N×16  Index entries:
              [0:4]   uint32 LE: chapter index number
              [4:8]   uint32 LE: data offset
              [8:12]  uint32 LE: compressed length
              [12:16] uint32 LE: uncompressed length
```

### A3. Rename `download_top1000.py` → `download_topN.py`

Since the core download logic has been extracted to `src/downloader.py`, this script becomes a thin orchestrator for "download the top N books from a plan file".

| Change | Detail |
|--------|--------|
| Rename file | `download_top1000.py` → `download_topN.py` |
| Add positional arg `N` | Number of top books to download from the plan (e.g. `python3 download_topN.py 1000`). Optional with a sensible default (all books in the plan). Replaces the implicit "1000" in the old name. |
| Change `PLAN_FILE` default | From `ranking_books.json` (doesn't exist) → `fresh_books_download.json` |
| Import from `src/downloader.py` | `AsyncBookClient`, `download_book` |
| Remove inline duplicates | Delete the local `AsyncBookClient` class and `download_book()` function |
| Keep | Plan file loading, `--plan`/`--exclude`/`--offset`/`-w` flags, queue-based worker spawning, summary reporting. The existing `--limit` flag can be kept as an alias or removed in favor of the positional `N`. |

**New usage:**

```bash
python3 download_topN.py 1000                     # top 1000 from default plan
python3 download_topN.py 500 -w 200               # top 500, 200 workers
python3 download_topN.py 2000 --plan custom.json   # top 2000 from custom plan
python3 download_topN.py --offset 500 1000         # skip first 500, then top 1000
```

### A4. Refactor `download_batch.py`

| Change | Detail |
|--------|--------|
| Import from `src/downloader.py` | `AsyncBookClient`, `download_book` |
| Remove inline duplicates | Delete the local `AsyncBookClient` class and `download_book()` function |
| Keep | `EMPTY_FOLDER_BOOKS`, `clean_wrong_downloads()`, `--clean` flag, `main_async()` orchestration |
| Adapt `main_async()` | Construct minimal `book_entry` dicts from raw book IDs: `{"id": book_id}`. The shared `download_book()` will fetch metadata when `first_chapter` is missing. |

### A5. Update `fetch_catalog.py` — bundle-aware audit

In `audit()`, when classifying books as complete/partial/need_download:

| Current | New |
|---------|-----|
| `local_ch = count of .txt files in crawler/output/{id}/` | `local_ch = len(txt_indices ∪ bundle_indices)` via updated `count_existing_chapters()` |
| Complete if `local_ch >= api_ch * 0.95` | Complete if `local_ch >= api_ch` (exact match, no 0.95 fudge factor) |

This ensures the generated plan files (`fresh_books_download.json`, etc.) won't include books that are already fully compressed in bundles.

### A6. Update `crawler-descryptor/README.md`

- Rename all `download_top1000.py` → `download_topN.py`
- Rename all `batch_download.py` → `download_batch.py`
- Update architecture diagram (`top1000` node → `download_topN`, `batch` node → `download_batch`)
- Update usage examples with new names and `N` parameter
- Document bundle-aware skip logic
- Update project structure listing

---

## Part B — binslib: Incremental pre-compress and import with gap validation

### B1. Update `pre-compress.ts` — incremental merge + gap validation

**Worker thread** — replace the current "skip or rebuild entirely" logic:

Current behavior:
```
if bundleChapterCount >= txtFileCount:
    skip entirely
else:
    re-compress ALL chapters from scratch (wasteful, loses existing bundle data)
```

New behavior:
```
bundleIndices = read existing bundle index entries (set of chapter numbers)
txtIndices    = set of chapter numbers from .txt files in crawler/output
newIndices    = txtIndices - bundleIndices

if newIndices is empty:
    skip (nothing new to compress)

if bundleIndices is non-empty AND newIndices is non-empty:
    maxBundle = max(bundleIndices)
    minNew    = min(newIndices)
    if minNew != maxBundle + 1:
        GAP ERROR → report to main thread, skip this book
        (bundle has up to chapter {maxBundle}, but first new .txt is {minNew})

// Incremental merge:
existingData = read existing bundle raw data (Map<indexNum, {compressed, rawLen}>)
for each new .txt file:
    compress body, add to existingData map
write combined bundle from merged map
```

**New worker→main message:** `book_gap_error { bookId, maxBundle, minNew, expectedNext }`

**Worker `done` message:** add `gapErrors: { bookId, maxBundle, minNew }[]` field

**Main thread changes:**
1. Collect `gapErrors` from all workers into `allGapErrors`
2. Add "Gap errors" row to the boxed summary report
3. List each gap error in the detail log and console output
4. Exit code 1 if any gap errors (alongside existing `totalFailed > 0`)

### B2. Update `import.ts` — gap validation before chapter insert

In `runImport()`, for each book, after creating `BundleWriter({ loadExisting: true })`:

```
bundleMaxIndex = bundleWriter.maxIndex()   // new helper method (see B3)
newTxtIndices  = [indices from .txt files NOT in bundleWriter]

if bundleMaxIndex != null AND newTxtIndices.length > 0:
    minNew = Math.min(...newTxtIndices)
    if minNew != bundleMaxIndex + 1:
        GAP ERROR → log, skip this book, count in report
        (bundle has up to {bundleMaxIndex}, first new .txt is {minNew})
```

**`ImportReport` additions:**

| Field | Type | Description |
|-------|------|-------------|
| `gapErrors` | `number` | Count of books skipped due to gap errors |
| `gapErrorDetails` | `{ bookId: number; maxBundle: number; minNew: number }[]` | Details for each |

**Report output:** add a "Gap errors" row in the boxed report. If any, list them after the "Failed books" section.

**Detail log:** each gap error logged as `GAP_ERROR {bookId}: bundle max={maxBundle}, first new txt={minNew}, expected={maxBundle+1}`

### B3. Add `BundleWriter.maxIndex()` to `chapter-storage.ts`

Small helper so `import.ts` can query the highest existing index without reaching into private `chapters` map:

```typescript
/** Return the highest chapter index in the buffer, or null if empty. */
maxIndex(): number | null {
  if (this.chapters.size === 0) return null;
  let max = -1;
  for (const k of this.chapters.keys()) {
    if (k > max) max = k;
  }
  return max;
}
```

Also add for convenience:

```typescript
/** Return the set of all chapter indices currently in the buffer. */
indices(): Set<number> {
  return new Set(this.chapters.keys());
}
```

---

## Part C — Documentation updates

### C1. Update root `README.md`

| Line | Current | New |
|------|---------|-----|
| Quick Start | `python3 batch_download.py` | `python3 download_batch.py` |
| Quick Start | `python3 download_top1000.py -w 100` | `python3 download_topN.py 1000 -w 100` |
| Subprojects table | `crawler-descryptor/` description | Mention `download_topN.py` and `download_batch.py` |

### C2. Update `CHANGELOG.md`

New `[0.2.3]` entry covering all changes in this plan.

---

## File change summary

| File | Action |
|------|--------|
| `crawler-descryptor/src/downloader.py` | **Create** — shared `AsyncBookClient` + `download_book()` |
| `crawler-descryptor/src/utils.py` | **Edit** — add `BINSLIB_COMPRESSED_DIR`, `read_bundle_indices()`, update `count_existing_chapters()` |
| `crawler-descryptor/download_top1000.py` | **Rename** → `download_topN.py`; import from `src/downloader.py`, add positional `N` arg, change default plan file |
| `crawler-descryptor/batch_download.py` | **Rename** → `download_batch.py`; import from `src/downloader.py`, remove duplicates |
| `crawler-descryptor/fetch_catalog.py` | **Edit** — bundle-aware audit, use `>= api_ch` (not `0.95`) |
| `crawler-descryptor/README.md` | **Edit** — rename all references, update diagrams, usage, project structure |
| `binslib/scripts/pre-compress.ts` | **Edit** — incremental bundle merge + gap validation in worker |
| `binslib/scripts/import.ts` | **Edit** — gap validation before chapter insert, report aggregation |
| `binslib/src/lib/chapter-storage.ts` | **Edit** — add `BundleWriter.maxIndex()` and `BundleWriter.indices()` |
| `README.md` | **Edit** — rename `download_top1000.py` → `download_topN.py`, `batch_download.py` → `download_batch.py` |
| `CHANGELOG.md` | **Edit** — new `[0.2.3]` version entry |

## Unchanged files

- `crawler-descryptor/main.py` — single-book CLI, uses sync `APIClient`, no duplication
- `crawler-descryptor/src/client.py` — sync API client, used by `main.py` only
- `crawler-descryptor/src/decrypt.py` — no changes needed
- `binslib/src/db/schema.ts` — no schema changes
- `binslib/scripts/migrate.ts` — no changes