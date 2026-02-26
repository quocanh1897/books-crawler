# Plan: Integrate TTV Source into `book-ingest`

## Context Summary

Currently there are **two separate, disconnected systems**:

|                  | **book-ingest** (active)           | **crawler-tangthuvien** (dormant)       |
| ---------------- | ---------------------------------- | --------------------------------------- |
| Source           | metruyencv.com mobile API          | truyen.tangthuvien.vn HTML              |
| Output           | BLIB v2 bundles + SQLite DB        | Flat text files in `output/`            |
| Content          | AES-128-CBC encrypted → decrypt    | Plain HTML → parse                      |
| Chapter walk     | Linked-list (`next.id` chaining)   | Sequential URLs (`chuong-1`, `chuong-2`, …) |
| IDs              | Native numeric (< 1M)             | 10M+ offset                            |

The goal is to make `book-ingest` natively support TTV as a second source, so one pipeline goes from **discovery → fetch → compress → bundle + DB** for both sources.

---

## Architecture: Source Abstraction Module

Create `book-ingest/src/sources/` with a base interface and per-source implementations:

```
book-ingest/src/sources/
├── __init__.py          # Source registry + factory function
├── base.py              # Abstract BookSource interface
├── mtc.py               # MTC implementation (extract from current code)
└── ttv.py               # TTV implementation (port from crawler-tangthuvien)
```

### `base.py` — Abstract Source Interface

```python
class BookSource(ABC):
    # -- Plan generation --
    async def discover_catalog(self) -> list[dict]:
        """Return lightweight plan entries (id, name, slug, chapter_count, ...)."""

    async def fetch_book_metadata(self, book_id: int) -> dict | None:
        """Fetch full metadata for a single book (same shape as plan entries)."""

    # -- Chapter ingestion --
    async def fetch_and_yield_chapters(self, book_id, slug, chapter_count, existing_indices):
        """Async generator yielding (index, title, slug, body, word_count) tuples.
           Skips indices in existing_indices. Source handles its own walk strategy."""

    # -- Cover --
    async def download_cover(self, book_id, cover_info, covers_dir) -> str | None:
        """Download cover image. Returns '/covers/{id}.jpg' or None."""

    # -- Identity --
    @property
    def name(self) -> str: ...            # "mtc" or "ttv"

    @property
    def plan_file(self) -> Path: ...      # default plan file location
```

**Why an async generator for chapters?** Because the two sources have fundamentally different walk strategies:

- **MTC**: linked-list traversal (`get_chapter(chapter_id)` → `next.id`), can resume from the last stored `chapter_id`, supports forward+reverse walk.
- **TTV**: sequential URL iteration (`/doc-truyen/{slug}/chuong-{N}`), simply loops 1..N, skipping existing.

Pushing the walk logic into the source keeps `ingest_book()` clean — it just iterates the generator, compresses, and writes.

---

## Changes to `ingest.py`

### 1. New `--source` argument

```python
parser.add_argument(
    "--source",
    choices=["mtc", "ttv"],
    default="mtc",
    help="Data source: mtc (metruyencv) or ttv (tangthuvien)",
)
```

### 2. Refactored `ingest_book()` — source-agnostic core

The current `ingest_book()` (L280–615) does MTC-specific things inline:

- Calls `client.get_book(book_id)` (MTC API)
- Calls `decrypt_chapter()` (MTC AES)
- Walks chapters via linked-list (MTC `next.id`)

The refactored version:

```python
async def ingest_book(source: BookSource, entry, compressor, ...):
    book_id = entry["id"]

    # 1. Fetch metadata (source-specific)
    meta = await source.fetch_book_metadata(book_id)

    # 2. Determine what's already on disk (unchanged — bundle + DB scan)
    bundle_indices = read_bundle_indices(bundle_path)
    # ...same skip/recovery logic...

    # 3. Walk chapters (source-specific generator)
    async for index, title, slug, body, word_count in source.fetch_and_yield_chapters(
        book_id, meta["slug"], meta["chapter_count"], existing
    ):
        compressed, raw_len = compressor.compress(body)
        pending_chapters[index] = (compressed, raw_len, title, slug, word_count, 0)
        # ...same flush logic...

    # 4. Final flush, cover download, DB update (unchanged)
    cover_url = await source.download_cover(
        book_id, meta.get("poster") or meta.get("cover_url"), COVERS_DIR
    )
    # ...
```

The **bundle write, DB upsert, compression, checkpoint flushing** all stay exactly the same. Only the data-fetching strategy changes per source.

### 3. `run_ingest()` — pass source to workers

```python
async def worker():
    # source is created per-worker (each needs its own HTTP client)
    source = create_source(source_name, max_concurrent=...)
    async with source:
        while True:
            entry = await queue.get()
            stats = await ingest_book(source, entry, ...)
```

---

## Changes to `generate_plan.py`

### 1. New `--source` argument

```python
parser.add_argument(
    "--source",
    choices=["mtc", "ttv"],
    default="mtc",
    help="Data source: mtc (metruyencv) or ttv (tangthuvien)",
)
```

### 2. TTV-specific plan generation: `run_generate_ttv()`

Port the discovery logic from `crawler-tangthuvien/discover.py`:

```python
def run_generate_ttv(dry_run, max_pages=50, min_chapters=100):
    """Scrape TTV listing pages, cross-ref with local bundles, write plan."""
    # 1. Scrape /tong-hop pages (reuse parser.parse_listing_page)
    # 2. For each discovered book, assign 10M+ offset ID
    # 3. Cross-reference with existing bundles
    # 4. Fetch full metadata from book detail pages for enrichment
    # 5. Write plan file (same format as MTC)
    # 6. Pull covers
```

### 3. TTV-specific refresh: `run_refresh_ttv()`

```python
async def run_refresh_ttv(entries, workers, delay, min_chapters):
    """Re-fetch metadata for all TTV books in the plan."""
    # For each entry: fetch /doc-truyen/{slug}, parse HTML
    # Update chapter_count, status, etc.
    # Detect removed books (404)
    # Discover new chapters
```

### 4. Plan file format — add `source` field

TTV plan entries include `"source": "ttv"` so `ingest.py` can auto-detect the source per book:

```json
{
  "id": 10000001,
  "name": "Mục Thần Ký",
  "slug": "muc-than-ky",
  "chapter_count": 1234,
  "status": 1,
  "source": "ttv",
  "author": {"id": 12345, "name": "Author Name"},
  "genres": [{"name": "Tiên Hiệp", "slug": "tien-hiep"}],
  "cover_url": "https://truyen.tangthuvien.vn/..."
}
```

The default plan file for TTV is stored separately: `data/ttv_books_download.json`.

---

## New Files in `book-ingest/src/`

### `src/sources/__init__.py` — Factory

```python
def create_source(name: str, **kwargs) -> BookSource:
    if name == "mtc":
        return MTCSource(**kwargs)
    elif name == "ttv":
        return TTVSource(**kwargs)
    raise ValueError(f"Unknown source: {name}")
```

### `src/sources/mtc.py` — MTC Implementation

Extracts the current MTC-specific logic from `ingest.py` and `api.py`:

- `fetch_book_metadata()` → wraps `AsyncBookClient.get_book()`
- `fetch_and_yield_chapters()` → the current linked-list walk + decrypt logic
- `download_cover()` → wraps existing `cover.py` logic

### `src/sources/ttv.py` — TTV Implementation

Ports and adapts from `crawler-tangthuvien/`:

- `fetch_book_metadata()` → fetch `/doc-truyen/{slug}`, parse with `parse_book_detail()`
- `fetch_and_yield_chapters()` → sequential `chuong-1..N`, parse with `parse_chapter()`
- `download_cover()` → direct HTTP GET from `cover_url`

Includes:

- Async HTTP client with semaphore-based rate limiting (adapted from `crawler-tangthuvien/src/client.py`)
- HTML parsers (copied from `crawler-tangthuvien/src/parser.py`)
- Book registry / ID assignment (from `crawler-tangthuvien/src/utils.py`)

---

## Data Flow Comparison

```
MTC path:
  generate_plan.py --source mtc  →  data/fresh_books_download.json
  ingest.py --source mtc         →  API → decrypt → compress → bundle + DB

TTV path:
  generate_plan.py --source ttv  →  data/ttv_books_download.json
  ingest.py --source ttv         →  HTML → parse → compress → bundle + DB

Both produce:
  ├── binslib/data/compressed/{book_id}.bundle   (BLIB v2)
  ├── binslib/data/binslib.db                    (SQLite, source="ttv"|"mtc")
  └── binslib/public/covers/{book_id}.jpg
```

---

## TTV-Specific Considerations

| Aspect              | Detail                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| **ID assignment**   | Use `book_registry.json` (10M+ offset). Port from `crawler-tangthuvien/src/utils.py`.          |
| **Chapter walk**    | Sequential 1..N, not linked-list. No `chapter_id` stored in bundle meta (set to 0).            |
| **Rate limiting**   | TTV needs heavier throttling (1.5s default vs 0.015s for MTC). The source class carries its own delay config. |
| **No decryption**   | TTV content is plain HTML. The `parse_chapter()` parser replaces `decrypt_chapter()`.          |
| **MTC dedup**       | During TTV plan generation, skip books that already exist as completed MTC books (same logic as `discover.py`). |
| **Dependencies**    | Need to add `beautifulsoup4` and `lxml` to `book-ingest/requirements.txt`.                     |

---

## Implementation Order

1. **`src/sources/base.py`** — Define abstract interface
2. **`src/sources/mtc.py`** — Wrap existing MTC logic (no behavior change)
3. **`src/sources/ttv.py`** — Port TTV client + parsers from `crawler-tangthuvien/`
4. **`src/sources/__init__.py`** — Factory function
5. **Refactor `ingest.py`** — Add `--source`, replace inline MTC calls with source abstraction
6. **Refactor `generate_plan.py`** — Add `--source`, add `run_generate_ttv()` and `run_refresh_ttv()`
7. **Update `requirements.txt`** — Add `beautifulsoup4`, `lxml`
8. **Test** — Run `ingest.py --source ttv` with a few TTV book IDs

---

## What Stays Unchanged

- `src/bundle.py` — BLIB v2 format (no changes)
- `src/compress.py` — zstd compression (no changes)
- `src/db.py` — SQLite operations (already has `source` parameter)
- `src/decrypt.py` — Only used by MTC source (no changes)
- `src/cover.py` — Reused by MTC source; TTV has its own simpler cover logic
- `epub-converter/` — Reads from bundles, source-agnostic
- `binslib/` — Reads from bundles + DB, source-agnostic

---

## Verification Tests

All tests run from `book-ingest/` with `python -m pytest` unless noted otherwise.

### Layer 1 — Unit Tests (no network, fully mocked)

These must all pass before any integration testing.

#### 1.1 MTC regression: `test_chapter_title.py` (existing)

```
python -m pytest test_chapter_title.py -v
```

**Why**: Refactoring `ingest_book()` to use the source abstraction must not break the existing MTC decrypt-chapter logic. This is the canary — if it fails, the extraction into `MTCSource` introduced a regression.

#### 1.2 Source factory: `tests/test_source_factory.py` (new)

| Test case | Assertion |
|---|---|
| `create_source("mtc")` | Returns `MTCSource` instance |
| `create_source("ttv")` | Returns `TTVSource` instance |
| `create_source("unknown")` | Raises `ValueError` |
| Both sources expose `.name` | `"mtc"` / `"ttv"` respectively |
| Both sources expose `.plan_file` | Correct default `Path` for each |

#### 1.3 TTV HTML parsers: `tests/test_ttv_parser.py` (new)

Save real HTML snapshots as fixtures in `tests/fixtures/` (one listing page, one book detail page, one chapter page). Tests parse the saved HTML — no network.

| Test case | Input fixture | Assertion |
|---|---|---|
| `parse_listing_page` | `listing_page.html` | Returns list of dicts with required keys (`slug`, `name`, `author_name`, `chapter_count`) |
| `parse_listing_page` empty | Minimal HTML with no `rank-view-list` | Returns `[]` |
| `parse_listing_total_pages` | `listing_page.html` | Returns correct `int` |
| `parse_book_detail` | `book_detail.html` | Returns dict with `name`, `slug`, `author`, `genres`, `chapter_count`, `status`, `cover_url`, `source="tangthuvien"` |
| `parse_book_detail` missing author | Fixture without author link | `author.name` is `""`, `author.id` is `None` |
| `parse_chapter` | `chapter.html` | Returns `{"title": ..., "body": ...}` with non-empty body |
| `parse_chapter` no content | HTML without `div.box-chap` | Returns `None` |
| `_extract_chapter_index` | Various URLs | Correct int extraction (`chuong-5` → 5, `3396871-chuong-75` → 75) |
| `_map_status` | `"Đã hoàn thành"`, `"Đang ra"`, `"Tạm dừng"` | `2`, `1`, `3` respectively |

#### 1.4 TTV metadata mapping: `tests/test_ttv_metadata.py` (new)

Verify that TTV metadata dicts produced by `parse_book_detail()` are correctly shaped for `upsert_book_metadata()`.

| Test case | Assertion |
|---|---|
| Plan entry with `source: "ttv"` through `_plan_entry_to_meta()` | Output has all required keys for `upsert_book_metadata()` |
| TTV book ID is ≥ 10,000,001 | ID offset is preserved through the pipeline |
| `author.id` from TTV (numeric from HTML) | Stored correctly, no `999`-prefix synthetic logic applied |
| Genres without `id` field (TTV only has name + slug) | `_resolved_id` is auto-assigned from DB or sequence |
| `source` field propagates to DB upsert call | `upsert_book_metadata(..., source="ttv")` |

#### 1.5 TTV ID registry: `tests/test_ttv_registry.py` (new)

Uses a temp directory to avoid touching the real `book_registry.json`.

| Test case | Assertion |
|---|---|
| `get_or_create_book_id("new-slug")` | Returns `10_000_001` on first call |
| Same slug called twice | Returns the same ID both times |
| Two different slugs | Returns sequential IDs (`10_000_001`, `10_000_002`) |
| `load_registry` / `save_registry` round-trip | JSON file matches in-memory dict |

### Layer 2 — Integration Tests (mocked HTTP, real bundle/DB writes)

Use `httpx`'s `MockTransport` or `respx` to stub HTTP responses. Write to a temp directory with a throwaway SQLite DB.

#### 2.1 TTV ingest pipeline: `tests/test_ttv_ingest.py` (new)

Mock the TTV HTML endpoints for a single 3-chapter book.

| Step | Assertion |
|---|---|
| `TTVSource.fetch_book_metadata(book_id)` with mocked `/doc-truyen/{slug}` | Returns valid metadata dict |
| `TTVSource.fetch_and_yield_chapters(...)` with mocked `/doc-truyen/{slug}/chuong-{1,2,3}` | Yields 3 `(index, title, slug, body, word_count)` tuples |
| Chapters skipped correctly | Pass `existing_indices={2}` → generator yields indices 1 and 3 only |
| Full `ingest_book()` with mocked source | Bundle file exists, is valid BLIB v2, contains 3 entries |
| DB after ingest | `books` row has `source='ttv'`, `chapters` table has 3 rows |
| Cover download | `covers/{book_id}.jpg` exists on disk |

#### 2.2 MTC ingest regression: `tests/test_mtc_ingest.py` (new)

Same structure as 2.1 but for `MTCSource` with mocked API + encrypted content. Verifies the refactored `ingest_book()` still works for MTC after the source abstraction.

| Step | Assertion |
|---|---|
| `MTCSource.fetch_book_metadata(book_id)` | Returns valid metadata dict with `first_chapter`, `latest_chapter` |
| `MTCSource.fetch_and_yield_chapters(...)` | Yields chapters with linked-list walk |
| Bundle file is valid BLIB v2 | `chapter_id` field in bundle meta is non-zero (MTC stores real chapter IDs) |
| DB row has `source='mtc'` | Unchanged from current behavior |

#### 2.3 TTV plan generation: `tests/test_ttv_plan.py` (new)

Mock the TTV listing-page HTTP responses.

| Step | Assertion |
|---|---|
| `run_generate_ttv(dry_run=True)` | Returns plan entries, does not write file |
| Plan entries have `source: "ttv"` | Every entry in the list |
| IDs are all ≥ 10,000,001 | Offset is applied |
| MTC dedup | A book whose slug exists in DB with `status=2` is excluded |
| Bundle cross-reference | A book with an existing bundle is classified as `have_complete` or `have_partial` |

### Layer 3 — Smoke Tests (real network, run manually)

These are **not automated** — run by hand during development and before merge. They hit real servers.

#### 3.1 TTV plan generation smoke

```bash
cd book-ingest

# Dry run — verify it connects, parses pages, prints summary, writes nothing
python3 generate_plan.py --source ttv --dry-run

# Generate a small plan (5 pages ≈ 100 books)
python3 generate_plan.py --source ttv --pages 5
# Verify: data/ttv_books_download.json exists, entries have source/slug/chapter_count
```

#### 3.2 TTV ingest smoke — single book

Pick a known small TTV book (< 20 chapters) for fast iteration.

```bash
# Dry run — verify metadata fetch, chapter count, no writes
python3 ingest.py --source ttv 10000001 --dry-run

# Real ingest — 1 book
python3 ingest.py --source ttv 10000001 -w 1
# Verify:
#   binslib/data/compressed/10000001.bundle exists and is valid BLIB v2
#   sqlite3 binslib/data/binslib.db "SELECT id, name, source, chapters_saved FROM books WHERE id=10000001"
#     → source='ttv', chapters_saved > 0
#   sqlite3 binslib/data/binslib.db "SELECT COUNT(*) FROM chapters WHERE book_id=10000001"
#     → matches chapters_saved
#   binslib/public/covers/10000001.jpg exists (if book has cover)
```

#### 3.3 TTV ingest smoke — batch from plan

```bash
# Ingest first 5 books from the TTV plan
python3 ingest.py --source ttv --plan data/ttv_books_download.json --limit 5 -w 2
# Verify: 5 bundle files, 5 book rows with source='ttv'
```

#### 3.4 MTC regression smoke

```bash
# Verify MTC still works after refactor (default --source is mtc)
python3 generate_plan.py --dry-run
python3 ingest.py 100358 --dry-run
```

#### 3.5 Downstream compatibility smoke

After ingesting at least one TTV book, verify the rest of the stack reads it correctly:

```bash
# EPUB generation
cd ../epub-converter
python3 convert.py --ids 10000001
# Verify: binslib/data/epub/10000001_*.epub exists and is a valid EPUB

# Web reader (manual)
cd ../binslib
npm run dev
# Open http://localhost:3000/book/10000001 — verify book page loads, chapters render
```

### Test File Layout

```
book-ingest/
├── test_chapter_title.py              # existing — MTC decrypt regression
└── tests/
    ├── __init__.py
    ├── conftest.py                    # shared fixtures: temp dirs, mock DB, mock HTTP
    ├── fixtures/
    │   ├── ttv_listing_page.html      # saved real HTML snapshot
    │   ├── ttv_book_detail.html
    │   └── ttv_chapter.html
    ├── test_source_factory.py         # 1.2
    ├── test_ttv_parser.py             # 1.3
    ├── test_ttv_metadata.py           # 1.4
    ├── test_ttv_registry.py           # 1.5
    ├── test_ttv_ingest.py             # 2.1
    ├── test_mtc_ingest.py             # 2.2
    └── test_ttv_plan.py               # 2.3
```

### Pass Criteria

| Gate | Requirement | When |
|---|---|---|
| **Unit pass** | All Layer 1 tests green | Before every commit |
| **Integration pass** | All Layer 2 tests green | Before PR review |
| **Smoke pass** | All Layer 3 checks verified | Before merge to `main` |
| **MTC no-regression** | Existing `test_chapter_title.py` green + smoke 3.4 passes | At every gate |