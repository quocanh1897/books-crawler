# book-ingest

Unified crawl-decrypt-compress-import pipeline for metruyencv (MTC).

Two main tools:

- **`generate_plan.py`** — discover books from the API catalog, enrich with full metadata, download covers, and write a plan file.
- **`ingest.py`** — read the plan file, fetch chapters from the API, decrypt, compress, and write to bundles + SQLite.

## Quick Start

```bash
pip install -r requirements.txt

# ── Step 1: Generate the plan ────────────────────────────────
# Paginate API catalog, cross-ref with local bundles, pull covers
python3 generate_plan.py

# Enrich the plan with full per-book metadata (author, genres, etc.)
python3 generate_plan.py --refresh

# Enrich + discover books invisible to the catalog endpoint
python3 generate_plan.py --refresh --scan --fix-author

# Only pull missing covers
python3 generate_plan.py --cover-only

# ── Step 2: Ingest chapters ─────────────────────────────────
# Ingest specific books
python3 ingest.py 100358 100441

# Ingest from plan file with 5 workers
python3 ingest.py -w 5

# Audit mode — report gaps without downloading
python3 ingest.py --audit-only

# Dry run
python3 ingest.py --dry-run
```

## Usage

```
python3 ingest.py [BOOK_IDS...] [OPTIONS]

Options:
  -w, --workers N       Parallel workers (default: 5)
  --plan PATH           Custom plan JSON file
  --flush-every N       Checkpoint interval in chapters (default: 100)
  --audit-only          Report missing data without downloading
  --dry-run             Simulate without writing
  --offset N            Skip first N entries in plan
  --limit N             Limit to N entries (0 = all)
```

## Architecture

```
API (metruyencv.com)
    │
    ▼
book-ingest (Python, async)
    ├─ fetch book metadata       GET /api/books/{id}
    ├─ check existing:           bundle indices + DB chapter rows
    ├─ walk chapter linked list:
    │   ├─ fetch chapter         GET /api/chapters/{id}
    │   ├─ decrypt               AES-128-CBC (key embedded in response)
    │   ├─ extract title/body    first line = title, rest = body
    │   ├─ compress body         zstd level 3 + global dictionary
    │   ├─ buffer in memory
    │   └─ every N chapters:     flush bundle + commit DB
    ├─ pull cover image
    └─ update book metadata in DB
```

### Pipeline Phases (per book)

1. **Metadata fetch** — `GET /api/books/{id}?include=author,creator,genres` returns book name, author, genres, chapter count, status, first/latest chapter IDs.

2. **Skip check** — compare API chapter count against local bundle indices. If the bundle is already complete, only update metadata if the hash has changed.

3. **Chapter walk** — traverse the chapter linked list (each chapter response contains `next.id` and `previous.id`). Strategy depends on existing data (see [Walk Strategies](#walk-strategies)).

4. **Decrypt + compress** — for each chapter: extract the AES key from the response, decrypt the ciphertext, parse title/body, compress the body with zstd.

5. **Checkpoint flush** — every N chapters (default 100): write pending chapters to the bundle file and commit chapter metadata rows to SQLite. This bounds memory usage and ensures progress is saved on interruption.

6. **Final flush** — write remaining chapters, pull cover image, update book metadata in DB with final `chapters_saved` count and `meta_hash`.

---

## Decryption

Source: `src/decrypt.py`

The MTC mobile API (`android.lonoapp.net`) returns chapter content as an encrypted string. The encryption uses **AES-128-CBC** in a Laravel-style envelope, but with the key embedded directly in the response.

### How It Works

The `content` field from `GET /api/chapters/{id}` is a modified base64 string:

```
[0..16]   normal base64 characters
[17..32]  ← 16 characters that ARE the AES key (raw byte values)
[33..]    remainder of base64 content
```

**Step 1 — Extract key and clean the base64:**

```python
key_chars = content[17:33]          # 16 characters at positions [17:33]
key_bytes = bytes(ord(c) for c in key_chars)  # convert to byte values → AES-128 key

clean_b64 = content.replace(key_chars, "", 1)  # remove key → valid base64
```

**Step 2 — Decode the JSON envelope:**

```python
raw_bytes = base64.b64decode(clean_b64)
envelope = json.loads(raw_bytes)
# envelope = {"iv": "<base64>", "value": "<base64>", "mac": "<hex>"}
```

| Field   | Content                          | Size        |
|---------|----------------------------------|-------------|
| `iv`    | Base64-encoded 16-byte AES IV    | 24 chars    |
| `value` | Base64-encoded AES-CBC ciphertext| Variable    |
| `mac`   | HMAC-SHA256 hex digest           | 64 chars    |

**Step 3 — Decrypt:**

```python
iv = base64.b64decode(envelope["iv"])           # 16 bytes
ciphertext = base64.b64decode(envelope["value"]) # N × 16 bytes

cipher = AES.new(key_bytes, AES.MODE_CBC, iv)
plaintext = unpad(cipher.decrypt(ciphertext), 16)  # PKCS7
text = plaintext.decode("utf-8").strip()
```

**Step 4 (optional) — Verify MAC:**

Laravel computes `HMAC-SHA256(iv_b64 + value_b64, key)`. The `mac` field can be verified before decryption for integrity checking, but is skipped by default for performance.

### Key Discovery

This scheme was reverse-engineered from the Dart AOT binary (`libapp.so`) of the Android app using blutter analysis. The function `_getChapterDetailsEncrypt` in `novelfever/utils/api_client.dart` revealed that:

- Positions `[17:33]` contain the key (not derived, not fetched separately — literally embedded in the response)
- Removing those 16 characters yields standard base64
- The decoded JSON follows Laravel's `Crypt::encrypt()` format

Earlier approaches tried extracting keys from the binary, brute-forcing IV formats, and hooking SSL with Frida — none worked. The embedded-key approach is the only one that decrypts successfully.

---

## Compression

Source: `src/compress.py`

Chapter bodies are compressed with **zstd level 3** using a shared **global dictionary** trained on representative chapter text. The dictionary is stored at `binslib/data/global.dict` and must be the same one used by the binslib reader for decompression.

```python
class ChapterCompressor:
    def __init__(self, dict_path: str, level: int = 3):
        self._dict = pyzstd.ZstdDict(open(dict_path, "rb").read())
        self._level = level

    def compress(self, body: str) -> tuple[bytes, int]:
        raw = body.encode("utf-8")
        compressed = pyzstd.compress(raw, level_or_option=self._level, zstd_dict=self._dict)
        return compressed, len(raw)  # (compressed_bytes, uncompressed_length)
```

| Metric | Typical value |
|--------|--------------|
| Compression ratio | ~3–5× with dictionary |
| Speed | ~50–100 chapters/second (single thread) |
| Dictionary size | ~100 KB |

The dictionary significantly improves compression ratio for small chapters (< 10 KB) where zstd's adaptive model doesn't have enough data to converge.

---

## Bundle Format (BLIB v2)

Source: `src/bundle.py`

All chapter data for a book is stored in a single **BLIB v2** bundle file: `binslib/data/compressed/{book_id}.bundle`. No individual per-chapter files.

### Layout (little-endian)

```
┌──────────────────────────────────────┐
│ Header (16 bytes)                    │
│   [4B] magic: "BLIB"                │
│   [4B] uint32: version (2)          │
│   [4B] uint32: entry count (N)      │
│   [2B] uint16: meta_entry_size (256)│
│   [2B] uint16: reserved (0)         │
├──────────────────────────────────────┤
│ Index (N × 16 bytes)                 │
│   For each chapter:                  │
│   [4B] uint32: chapter index number  │
│   [4B] uint32: block offset          │
│   [4B] uint32: compressed data len   │
│   [4B] uint32: uncompressed data len │
├──────────────────────────────────────┤
│ Chapter blocks (variable)            │
│   For each chapter at block offset:  │
│   ┌────────────────────────────────┐ │
│   │ Metadata prefix (256 bytes)    │ │
│   │   [4B] chapter_id (API ID)     │ │
│   │   [4B] word_count              │ │
│   │   [1B] title_len (max 196)     │ │
│   │ [196B] title (UTF-8, 0-padded) │ │
│   │   [1B] slug_len (max 48)       │ │
│   │  [48B] slug (UTF-8, 0-padded)  │ │
│   │   [2B] reserved (0)            │ │
│   ├────────────────────────────────┤ │
│   │ Compressed data (N bytes)      │ │
│   │   zstd-compressed chapter body │ │
│   └────────────────────────────────┘ │
└──────────────────────────────────────┘
```

### Read paths

| Operation | How |
|-----------|-----|
| Read chapter body | `seek(offset + 256)`, `read(compLen)`, zstd decompress |
| Read chapter meta | `seek(offset)`, `read(256)`, parse fixed-layout struct |
| List all indices | Read 16B header + N×16B index (no data reads) |

### Why inline metadata?

The 256-byte metadata prefix makes each chapter block self-contained. If the SQLite database is lost, chapter titles, slugs, word counts, and API chapter IDs can be recovered by scanning the metadata blocks — no decompression needed. The stored `chapter_id` also enables O(missing) chapter walk resumption instead of O(total) linked-list traversal from chapter 1.

Overhead: 256 bytes/chapter ≈ 512 KB for a 2000-chapter book ≈ 6% of a typical bundle.

### v1 compatibility

v1 bundles (12-byte header, no metadata prefix) remain readable. All readers accept both versions. New writes always produce v2.

---

## Database Operations

Source: `src/db.py`

The pipeline writes to the same SQLite database that binslib uses (`binslib/data/binslib.db`), with WAL mode and foreign keys enabled to match the Next.js runtime.

### Connection setup

```python
conn = sqlite3.connect(db_path)
conn.execute("PRAGMA journal_mode = WAL")
conn.execute("PRAGMA foreign_keys = ON")
```

### Book upsert

`upsert_book_metadata()` performs a single-transaction upsert of all related entities:

1. **Author** — `INSERT OR REPLACE INTO authors` (id, name, local_name, avatar). Author IDs may be integers or strings like `"c1000024"` (the `c` prefix is stripped).

2. **Genres** — `INSERT OR IGNORE INTO genres` (id, name, slug). For genres without numeric IDs (e.g. TTV genres), auto-assigns IDs by `MAX(id) + 1`.

3. **Tags** — `INSERT OR REPLACE INTO tags` (id, name, type_id).

4. **Slug conflict resolution** — if another book already has the same slug, that book and all its chapters/junctions are deleted first. This handles API-side slug reassignments.

5. **Book row** — `INSERT ... ON CONFLICT(id) DO UPDATE` with all metadata fields. Uses `ON CONFLICT DO UPDATE` instead of `INSERT OR REPLACE` to avoid cascade-deleting chapters (the `chapters` table has `ON DELETE CASCADE` on `book_id`).

6. **Junctions** — `INSERT OR IGNORE INTO book_genres` and `book_tags`.

### Chapter insert

`insert_chapters()` writes chapter metadata rows:

```python
INSERT OR REPLACE INTO chapters (book_id, index_num, title, slug, word_count)
VALUES (?, ?, ?, ?, ?)
```

Chapter **bodies are NOT stored in the database**. Only metadata (title, slug, word count) goes into SQLite. Bodies live in the bundle file on disk.

### FK constraint handling

The book row must exist before any chapter rows can be inserted (foreign key constraint on `chapters.book_id`). The pipeline ensures this by upserting the book row with `chapters_saved=0` before the chapter walk begins, then updating `chapters_saved` to the final count after the last flush.

### Incremental change detection

Each book's metadata is hashed with `MD5(json.dumps(meta, sort_keys=True))`. On re-run, if the stored `meta_hash` matches and the bundle already has `≥ api_chapter_count` chapters, the book is skipped entirely (no API calls, no DB writes). This makes re-runs near-instantaneous for unchanged books.

### Chapter row recovery

When a bundle is complete but the DB is missing chapter rows (e.g. after a DB rebuild), the pipeline reads inline metadata from the v2 bundle and inserts the missing rows without any API calls or decompression.

---

## Walk Strategies

Source: `ingest.py` — `ingest_book()`

The MTC API exposes chapters as a linked list: each chapter response contains `next: {id}` and `previous: {id}`. There is no "get all chapters" endpoint, so the pipeline must walk the list. The strategy depends on what data already exists locally.

### Forward walk (default for new books)

Start from `first_chapter` (from book metadata), follow `next.id` until `null`.

```
ch_1 → ch_2 → ch_3 → ... → ch_N → null
```

Cost: O(total) API calls. Used when no bundle exists.

### Resume walk (O(missing) for partial bundles)

When a v2 bundle exists, the stored `chapter_id` in the last chapter's inline metadata allows direct resumption:

1. Fetch the last known chapter by its stored `chapter_id`
2. Follow `next.id` from there

```
[bundle: ch_1..ch_500] → resume from ch_500.next → ch_501 → ... → ch_N
```

Cost: O(missing) API calls. This is the primary optimization from v2 metadata.

### Reverse walk (fallback for v1 bundles)

When a bundle exists but has no stored `chapter_id` (v1 format), the pipeline starts from `latest_chapter` (from book metadata) and walks backwards via `previous.id`, stopping at the first chapter that's already in the bundle.

```
ch_N ← ch_{N-1} ← ... ← ch_501 ← [stop: ch_500 exists in bundle]
```

Cost: O(missing) API calls. Equivalent to resume, but walks in reverse.

### Fallback

If the stored `chapter_id` returns 404 (stale data — the API reassigned IDs), the pipeline falls back to reverse walk from `latest_chapter`. If `latest_chapter` is also unavailable, falls back to full forward walk from `first_chapter`.

---

## Plan Generation

Source: `generate_plan.py`

`generate_plan.py` is the single tool for building and maintaining the download plan. It merges the functionality of the old `meta-puller --meta-only` (catalog pagination) and `refresh_catalog.py` (per-book enrichment) into one file.

### Modes

| Mode | Command | What it does |
|------|---------|--------------|
| **Generate** (default) | `python3 generate_plan.py` | Paginate `/api/books` catalog, cross-ref with local bundles, write a fresh plan, pull missing covers |
| **Refresh** | `python3 generate_plan.py --refresh` | Read existing plan, fetch full per-book metadata (author, genres, tags, synopsis, poster, stats), write enriched plan |
| **Refresh + scan** | `python3 generate_plan.py --refresh --scan` | Same as refresh, plus probe every ID in the MTC range (100003–153500+) to discover books invisible to the catalog listing endpoint |
| **Cover only** | `python3 generate_plan.py --cover-only` | Only download missing cover images to `binslib/public/covers/`; skip plan generation |

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--refresh` | off | Enrich existing plan with full per-book API metadata |
| `--scan` | off | (With `--refresh`) Scan full MTC ID range for undiscovered books |
| `--cover-only` | off | Only download covers; skip plan |
| `--fix-author` | off | Generate synthetic author from creator when author is missing or placeholder (id = `999{creator_id}`) |
| `--min-chapters N` | 100 | Exclude books with fewer than N chapters |
| `--workers N` | 150 | Max concurrent API requests for `--refresh` |
| `--delay N` | 0.015 | Seconds between API requests |
| `--ids N...` | all | Specific book IDs for `--cover-only` |
| `--force` | off | Re-download covers even if they exist |
| `--dry-run` | off | Preview without writing any files |

### Typical workflow

```bash
# First time: generate initial plan from catalog
python3 generate_plan.py

# Enrich with full metadata + discover missing books
python3 generate_plan.py --refresh --scan --fix-author

# Ingest the books
python3 ingest.py -w 5

# Later: refresh metadata for changed chapter counts
python3 generate_plan.py --refresh

# Pull covers for newly ingested books
python3 generate_plan.py --cover-only
```

### Generate mode internals

1. Paginate `/api/books` (lightweight entries: id, name, chapter_count, first_chapter)
2. Scan `binslib/data/compressed/*.bundle` to get local chapter counts
3. Classify each book: complete (local ≥ API), partial (local < API), or missing
4. Write the plan as a flat JSON array to `data/fresh_books_download.json`
5. Write an audit summary to `data/catalog_audit.json`
6. Pull missing cover images

### Refresh mode internals

1. Read existing `data/fresh_books_download.json`
2. For each book ID, fetch full metadata via `GET /api/books/{id}?include=author,creator,genres`  (150 concurrent requests by default)
3. Detect changes: new chapters, removed books (404), name changes
4. Apply `--fix-author`: generate `{id: 999{creator_id}, name: creator_name}` for books without authors
5. Apply `--min-chapters`: filter out small books
6. Optionally `--scan`: probe every unknown ID in the 100003–153500 range
7. Write enriched plan back, sorted by chapter_count descending

---

## Plan File Format

Source: `ingest.py` — `load_plan()`

The plan file (`data/fresh_books_download.json`) tells the ingest pipeline which books to process. It is generated by `generate_plan.py`.

### Flat array format (preferred)

```json
[
  {
    "id": 100890,
    "name": "Book Name",
    "slug": "book-name",
    "chapter_count": 2990,
    "first_chapter": 11063426,
    "status": "Hoàn thành",
    "kind": 1,
    "sex": 1,
    "word_count": 7807531
  }
]
```

### Structured format (also accepted)

```json
{
  "summary": { ... },
  "need_download": [ ... ],
  "partial": [ ... ]
}
```

The loader merges entries from `need_download`, `partial`, `have_partial`, and `books` keys.

### Minimal format (CLI book IDs)

When book IDs are passed on the command line instead of a plan file, each entry is just `{"id": N}`. The pipeline fetches metadata from the API to fill in `first_chapter`, `chapter_count`, etc.

---

## File Paths

| Resource | Path |
|---|---|
| Bundle files | `binslib/data/compressed/{book_id}.bundle` |
| SQLite DB | `binslib/data/binslib.db` |
| Zstd dictionary | `binslib/data/global.dict` |
| Cover images | `binslib/public/covers/{book_id}.jpg` |
| Plan file | `book-ingest/data/fresh_books_download.json` |
| Catalog audit | `book-ingest/data/catalog_audit.json` |
| Detail log | `book-ingest/data/ingest-detail.log` |
| Summary log | `book-ingest/data/ingest-log.txt` |
| Audit log | `book-ingest/data/audit.log` |

## Source Files

| File | Purpose |
|---|---|
| `generate_plan.py` | Plan generation: catalog pagination, per-book refresh, ID-range scan, cover download |
| `ingest.py` | Chapter ingest: worker pool, per-book fetch → decrypt → compress → bundle + DB |
| `refresh_catalog.py` | (Legacy) Predecessor to `generate_plan.py --refresh`; kept for reference |
| `repair_titles.py` | Fix chapter titles in DB from bundle metadata or API |
| `migrate_v2.py` | Convert v1 bundles to v2 with metadata from DB or `--refetch` from API |
| `src/api.py` | Async HTTP client (`AsyncBookClient`), rate limiting, `decrypt_chapter()` |
| `src/decrypt.py` | AES-128-CBC decryption: key extraction, envelope parsing, plaintext recovery |
| `src/compress.py` | Zstd compression with global dictionary |
| `src/bundle.py` | BLIB v1/v2 bundle reader and v2 writer (read/write indices, raw data, metadata) |
| `src/cover.py` | Async cover image download with size-variant fallback |
| `src/db.py` | SQLite operations: upsert book/author/genres/tags, insert chapters, change detection |

## Dependencies

| Package | Purpose |
|---|---|
| `httpx` | Async HTTP client for API requests |
| `pycryptodome` | AES-128-CBC decryption (PyCrypto-compatible) |
| `pyzstd` | Zstd compression/decompression with dictionary support |
| `rich` | Terminal progress bars, tables, and styled console output |