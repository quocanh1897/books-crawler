# book-ingest: Bundle v2 Implementation Checkpoint

## Current State
- **Branch:** `bundle-v2` (based on `main` at `59a0da3`)
- **Status:** v2 format implemented, needs final integration test + TS reader update

## Completed Work

### 1. Full pipeline on `main` (commit 59a0da3)
All files in `book-ingest/`:
- `ingest.py` (757 lines) — CLI entry point, worker pool, per-book flow, audit mode
- `src/api.py` — async API client (semaphore rate limiting, retry)
- `src/bundle.py` — BLIB bundle reader/writer
- `src/compress.py` — zstd with global dictionary
- `src/db.py` — SQLite ops (ON CONFLICT DO UPDATE to avoid cascade deletes)
- `src/cover.py` — cover download with poster URL fallback
- `src/decrypt.py` — symlink to `crawler-descryptor/src/decrypt.py`
- `README.md`, `requirements.txt`, `.gitignore`
- Root `README.md` updated with book-ingest in architecture diagram + subprojects table

### 2. BLIB v2 format (on `bundle-v2` branch)
**v2 layout:**
```
[4B] magic: "BLIB"
[4B] version: 2
[4B] entry count (N)
[4B] meta section offset    <-- NEW (0 = no metadata)
[N x 16B] index entries     (unchanged from v1)
[variable] compressed data  (unchanged)
[variable] metadata JSON    <-- NEW
  {"<index>": {"t": title, "s": slug, "w": word_count}, ...}
```

**Changes made:**
- `src/bundle.py`: added `ChapterMeta` dataclass, `read_bundle_meta()`, updated `write_bundle()` to accept optional meta dict, backward compat with v1
- `ingest.py`: `_flush_checkpoint()` writes v2 bundles with metadata; "bundle complete" path recovers missing DB chapter rows from v2 bundle metadata
- All existing v1 bundles (21,103 files) remain readable

### 3. Verified
- v2 bundle round-trip (write → read indices + raw + meta) pass
- v1 backward compat (read existing bundles) pass
- Real ingest: book 100267 fetched 14 new chapters pass
- Re-run skip logic: 0 new on second run pass
- ON CONFLICT fix: metadata update preserves chapter rows pass

## Remaining Tasks

### Task 1: Run real v2 ingest test
```bash
cd /data/mtc/book-ingest
python3 ingest.py 103293 -w 1   # has 1 missing chapter per live API
```
Then verify:
```python
from src.bundle import read_bundle_meta
meta = read_bundle_meta('../binslib/data/compressed/103293.bundle')
# Should return ChapterMeta for the new chapter
```

### Task 2: Update TypeScript reader for v2
File: `binslib/src/lib/chapter-storage.ts`

The reader currently rejects bundles with `version !== 1`. Need to:
1. Accept version 1 or 2
2. For v2: read `meta_offset` from header bytes 12-16, use 16-byte header size
3. Index entries and data section are identical — just adjust the header parsing
4. The TS reader doesn't need the metadata section (it's for Python-side DB recovery)

Key locations in chapter-storage.ts:
- `readBundleIndex()` — validates version, reads header + index
- `readFromBundle()` — reads single chapter by index
- `readAllBundleRaw()` — reads all chapters

### Task 3: Commit & push
```bash
git add book-ingest/src/bundle.py book-ingest/ingest.py binslib/src/lib/chapter-storage.ts
git commit -m "Add BLIB v2 bundle format with chapter metadata section"
git push -u origin bundle-v2
```

## Bug Found & Fixed
`INSERT OR REPLACE INTO books` with `ON DELETE CASCADE` on `chapters.book_id` causes all chapter rows to be deleted when book metadata is updated. Fixed by using `INSERT INTO books ... ON CONFLICT(id) DO UPDATE SET ...` instead.
