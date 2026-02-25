# book-ingest: Bundle v2 Implementation Checkpoint

## Current State
- **Branch:** `bundle-v2` (based on `main` at `59a0da3`)
- **Status:** v2 format redesigned (inline per-chapter metadata), needs implementation + TS reader update

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

### 2. Bug found & fixed
`INSERT OR REPLACE INTO books` with `ON DELETE CASCADE` on `chapters.book_id` causes all chapter rows to be deleted when book metadata is updated. Fixed by using `INSERT INTO books ... ON CONFLICT(id) DO UPDATE SET ...` instead.

### 3. Verified (v1 pipeline)
- Real ingest: book 100267 fetched 14 new chapters pass
- Re-run skip logic: 0 new on second run pass
- ON CONFLICT fix: metadata update preserves chapter rows pass

## BLIB v2 Format (revised design)

### Problem with original v2 (trailing JSON metadata)
The first v2 design stored a separate metadata JSON blob at the end of the file, tracked by a `meta_offset` field in the header. This has issues:
- `meta_offset` must be recomputed on every write (chapters are appended → data section grows → metadata section shifts)
- Trailing blob is structurally disconnected from the chapters it describes
- Risk of TS reader accidentally reading metadata bytes as chapter data if boundary is wrong

### Revised v2: inline per-chapter metadata

Each chapter's metadata is stored as a **fixed-size block** directly before its compressed data, forming a self-contained chapter block. No trailing section, no `meta_offset`.

**Header (16 bytes):**

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | Magic bytes `BLIB` |
| 4 | 4 | Version (uint32, `2`) |
| 8 | 4 | Entry count N (uint32) |
| 12 | 2 | Meta entry size M (uint16, `256` for v2) |
| 14 | 2 | Reserved (uint16, `0`) |

**Index entries (N × 16 bytes, unchanged from v1):**

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | Chapter index number (uint32) |
| 4 | 4 | Block offset from file start (uint32) — points to meta+data block |
| 8 | 4 | Compressed data length (uint32) — excludes metadata prefix |
| 12 | 4 | Uncompressed data length (uint32) |

**Per-chapter block (at block offset):**

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | `chapter_id` (uint32, API ID, 0 = unknown) |
| 4 | 4 | `word_count` (uint32) |
| 8 | 1 | `title_len` (uint8, actual UTF-8 bytes, max 196) |
| 9 | 196 | `title` (UTF-8, zero-padded) |
| 205 | 1 | `slug_len` (uint8, actual bytes, max 48) |
| 206 | 48 | `slug` (UTF-8, zero-padded) |
| 254 | 2 | Reserved (zero) |
| **256** | `compressedLen` | zstd-compressed chapter text |

Total metadata block: **256 bytes** per chapter.

### Read paths

| Operation | Steps |
|-----------|-------|
| Read chapter data | `seek(offset + meta_size)`, `read(compressedLen)` |
| Read chapter meta | `seek(offset)`, `read(meta_size)` |
| Read both | `seek(offset)`, `read(meta_size + compressedLen)` |
| Read all indices | Read 16B header + N×16B index (same as v1) |
| Resume walk | Read max-index chapter's `chapter_id` from meta → fetch → get `next.id` |

### Backward compatibility

- **v1 bundles**: readers check version; v1 has 12B header, no metadata prefix, `meta_size = 0`
- **v2 bundles**: 16B header, `meta_size` from header bytes 12–13, skip prefix before data
- **v1 readers** already reject `version !== 1` → no corruption risk
- All 21,103 existing v1 bundles remain readable
- v1 bundles have no stored `chapter_id` → first re-run uses reverse walk, subsequent runs resume

### Overhead

For a 2000-chapter book:
- Header: 16B (was 12B) → +4B
- Index: 2000 × 16B = 32KB (unchanged)
- Metadata: 2000 × 256B = **512KB** (~6% of a typical ~8MB bundle)
- Total overhead: negligible

### Why this is better

| Concern | Old v2 (trailing JSON) | New v2 (inline fixed meta) |
|---------|----------------------|---------------------------|
| Address changes on chapter append? | Yes, must recompute `meta_offset` | No, each chapter is self-contained |
| Self-describing per chapter? | No, disconnected JSON blob | Yes, meta is co-located with data |
| TS reader complexity | Must parse `meta_offset`, guard data boundary | Just skip `meta_size` bytes before data |
| Future-proof | No | `meta_entry_size` in header allows size changes without version bump |
| Walk optimization | N/A | Stored `chapter_id` enables O(missing) resume instead of O(total) walk |

## Remaining Tasks

### Task 1: Implement v2 in Python (`book-ingest/src/bundle.py`) ✅
- Added v2 constants, `ChapterMeta` dataclass (with `chapter_id`, `word_count`, `title`, `slug`)
- `write_bundle()` always writes v2 with per-chapter metadata blocks
- All readers (`read_bundle_indices`, `read_bundle_raw`, `read_bundle_meta`) accept v1 + v2
- v1 backward compatibility verified against real bundles

### Task 2: Update `ingest.py` to write v2 + resume optimization ✅
- `_flush_checkpoint()` passes `ChapterMeta` (including `chapter_id`) to `write_bundle()`
- "bundle complete" recovery path reads metadata from v2 bundles to reconstruct missing DB rows
- **Resume walk**: reads last chapter's `chapter_id` from bundle meta → fetches it → walks forward from `next.id`
- **Reverse walk fallback**: if stored `chapter_id` is stale (404), walks backwards from `latest_chapter` via `previous.id`
- Turns chapter walk from O(total) to O(missing) for the common tail-append case

### Task 3: Update TypeScript reader (`binslib/src/lib/chapter-storage.ts`) ✅
- Readers accept v1 and v2 (`metaEntrySize` + `headerSize` in `BundleIndex`)
- `readFromBundle()` skips meta prefix for v2
- `readAllBundleRaw()` preserves `metaBlock` for round-trip
- `writeBookBundleRaw()` / `BundleWriter` always write v2 format

### Task 4: Update `crawler-descryptor/src/utils.py` ✅
- `read_bundle_indices()` accepts v1 and v2 bundles

### Task 5: Test ✅
- v2 encode/decode round-trip (with chapter_id) pass
- v2 write → read indices, raw data, metadata pass
- v1 backward compat (synthetic + real 1067-chapter bundle) pass
- v1→v2 merge preserves data, adds metadata pass
- 10 fresh books ingested as v2 (518 chapters, 0 errors) pass
- TS reader reads v2 bundles correctly pass
- TS reader still reads v1 bundles pass

### Task 6: Test resume/reverse walk with books with missing chapters
```bash
cd /data/mtc/book-ingest
# Pick books with missing tail chapters
python3 ingest.py 150741 110037 103293 -w 3
# Should see RESUME or REVERSE log lines instead of full forward walk
tail -20 data/ingest-detail.log
```

### Task 7: Commit & push
```bash
git add book-ingest/src/bundle.py book-ingest/ingest.py binslib/src/lib/chapter-storage.ts
git add book-ingest/CHECKPOINT.md book-ingest/README.md binslib/README.md
git add crawler-descryptor/src/utils.py
git commit -m "BLIB v2: inline metadata with chapter_id, resume/reverse walk optimization"
git push -u origin bundle-v2
```
