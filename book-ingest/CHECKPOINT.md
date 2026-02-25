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
| 0 | 4 | `word_count` (uint32) |
| 4 | 1 | `title_len` (uint8, actual UTF-8 bytes, max 200) |
| 5 | 200 | `title` (UTF-8, zero-padded) |
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

### Backward compatibility

- **v1 bundles**: readers check version; v1 has 12B header, no metadata prefix, `meta_size = 0`
- **v2 bundles**: 16B header, `meta_size` from header bytes 12–13, skip prefix before data
- **v1 readers** already reject `version !== 1` → no corruption risk
- All 21,103 existing v1 bundles remain readable

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

## Remaining Tasks

### Task 1: Implement v2 in Python (`book-ingest/src/bundle.py`)
- Add v2 constants: `BUNDLE_VERSION_2 = 2`, `HEADER_SIZE_V2 = 16`, `META_ENTRY_SIZE = 256`
- Add `ChapterMeta` dataclass: `word_count`, `title`, `slug`
- Update `write_bundle()` to accept optional metadata per chapter, write v2 format
- Update `read_bundle_indices()` to handle both v1 (12B header) and v2 (16B header)
- Update `read_bundle_raw()` to skip metadata prefix for v2
- Add `read_bundle_meta()` to read metadata blocks without decompressing chapter data
- Maintain v1 read backward compatibility

### Task 2: Update `ingest.py` to write v2
- `_flush_checkpoint()` passes chapter metadata (title, slug, word_count) to `write_bundle()`
- "bundle complete" recovery path reads metadata from v2 bundles to reconstruct missing DB rows

### Task 3: Update TypeScript reader (`binslib/src/lib/chapter-storage.ts`)
- Accept version 1 or 2
- For v2: read `meta_entry_size` from header bytes 12–13, use 16B header
- `readFromBundle()`: seek to `offset + meta_entry_size` instead of `offset`
- `readBundleIndex()`: parse 16B header for v2, 12B for v1
- `readAllBundleRaw()`: skip meta prefix when extracting compressed data
- `writeBookBundleRaw()` / `BundleWriter`: write v2 format with metadata blocks
- The TS side doesn't need to read/parse the metadata content (that's for Python DB recovery)

### Task 4: Test
```bash
# Real v2 ingest test
cd /data/mtc/book-ingest
python3 ingest.py 103293 -w 1

# Verify metadata round-trip
python3 -c "
from src.bundle import read_bundle_meta
meta = read_bundle_meta('../binslib/data/compressed/103293.bundle')
for idx, m in sorted(meta.items())[:3]:
    print(f'  [{idx}] {m.title[:40]}  wc={m.word_count}')
"

# Verify v1 backward compat
python3 -c "
from src.bundle import read_bundle_indices
indices = read_bundle_indices('../binslib/data/compressed/100267.bundle')
print(f'v1 bundle: {len(indices)} chapters')
"
```

### Task 5: Commit & push
```bash
git add book-ingest/src/bundle.py book-ingest/ingest.py binslib/src/lib/chapter-storage.ts
git add book-ingest/CHECKPOINT.md book-ingest/README.md binslib/README.md
git commit -m "BLIB v2: inline per-chapter metadata (256B fixed block per chapter)"
git push -u origin bundle-v2
```
