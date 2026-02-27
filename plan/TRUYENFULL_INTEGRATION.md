# Plan: Integrate TruyenFull Source (`tf`) into `book-ingest`

## Context

Add [truyenfull.vision](https://truyenfull.vision) as a third data source (`tf`) alongside MTC and TTV. Only completed ("Full") hot books with ≥100 chapters that don't already exist in MTC or TTV are ingested.

## Site Structure (from inspection)

### Listing page — "Truyện Hot hoàn (full)"

```
URL:  https://truyenfull.vision/danh-sach/truyen-hot/trang-{N}/
From: https://truyenfull.vision/danh-sach/truyen-hot/trang-1/
To:   https://truyenfull.vision/danh-sach/truyen-hot/trang-1384/
Pages: 1,384 pages, ~27 books/page ≈ 37,000 completed hot books
```

Each book entry on the listing page:

| Element | Selector / location | Example |
|---|---|---|
| Title | `<h3>` inside listing item | Thần Đạo Đan Tôn |
| Author | Text next to title | Cô Đơn Địa Phi |
| Chapter count | "Chương 5357" text | 5357 |
| Book URL | `<a href>` | `/than-dao-dan-ton-6060282/` |

Pagination: `/trang-1/`, `/trang-2/`, …, `/trang-1384/`; "Cuối »" link gives last page number.

### Book detail page

```
URL:  https://truyenfull.vision/{slug}-{tf_id}/
Example: https://truyenfull.vision/than-dao-dan-ton-6060282/
```

| Data | Location | Example |
|---|---|---|
| Title | `<h1>` | Thần Đạo Đan Tôn |
| Author | Text after "Tác giả:" | Cô Đơn Địa Phi |
| Genres | Text after "Thể loại:" links | Tiên Hiệp, Huyền Huyễn |
| Status | Text after "Trạng thái:" | Full |
| Rating | `<b>` near "Đánh giá:" | 6.8/10 từ 10031 lượt |
| Synopsis | Long text block below metadata | Lăng Hàn - Một Đan Đế… |
| Chapter list | `<a>` links inside chapter section | Chương 1: Sống lại, Chương 2: Cường thế, … |

Chapter list is paginated (50 per page). Pagination links on the book detail page.

The **TF book ID** is embedded in the URL slug: `than-dao-dan-ton-6060282` → `6060282`.

### Chapter page

```
URL:  https://truyenfull.vision/{slug}-{tf_id}/chuong-{N}/
Example: https://truyenfull.vision/than-dao-dan-ton-6060282/chuong-1/
```

| Data | Location | Example |
|---|---|---|
| Book title | `<h1>` | Thần Đạo Đan Tôn |
| Chapter title | `<h2>` | Chương 1: Sống lại |
| Body | Paragraphs between chapter nav elements | Plain text paragraphs |
| Nav | "Chương trước" / "Chương tiếp" links | Sequential navigation |

Body text is plain HTML paragraphs directly in the page (no `<div class="box-chap">` wrapper like TTV).

---

## Key Differences from TTV

| Aspect | TTV | TF |
|---|---|---|
| Base URL | `truyen.tangthuvien.vn` | `truyenfull.vision` |
| Book URL | `/doc-truyen/{slug}` | `/{slug}-{tf_id}/` |
| Chapter URL | `/doc-truyen/{slug}/chuong-{N}` | `/{slug}-{tf_id}/chuong-{N}/` |
| Chapter body | `<div class="box-chap">` elements | Direct paragraph elements |
| Chapter title | `<h2>`, also duplicated in `<h5>` inside box-chap | `<h2>` only (clean) |
| Book IDs | Slug-only (registry assigns 10M+ offset) | Embedded in URL (`-6060282`) |
| Discovery | `/tong-hop` all books by recency | `/danh-sach/truyen-hot/` hot + full only |
| Scope | All books (ongoing + completed) | Only completed ("Full") hot books |
| Chapter list | First 75 on book page, AJAX for rest | 50 per page, HTML pagination |
| Auth | None | None |

---

## ID Strategy

| Entity | Offset | Range | Example |
|---|---|---|---|
| TF book IDs | `30_000_000` | 30M+ | `than-dao-dan-ton` → `30000001` |
| TF author IDs | `40_000_000` | 40M+ | TF author 42 → `40000042` |

The TF site embeds a native numeric ID in the URL (`6060282`), but we still use our own offset-based IDs for consistency with MTC/TTV. A registry file (`data/book_registry_tf.json`) maps `{slug}-{tf_id}` → our assigned book ID.

---

## Architecture

### New file: `src/sources/tf.py`

Follows the same pattern as `ttv.py`:

```python
# Config
TF_BASE_URL = "https://truyenfull.vision"
TF_HEADERS = { "user-agent": "..." }
TF_DEFAULT_DELAY = 0.3
TF_DEFAULT_MAX_CONCURRENT = 20
ID_OFFSET = 30_000_000
AUTHOR_ID_OFFSET = 40_000_000

# Parsers (self-contained in tf.py, same as TTV pattern)
def parse_hot_listing_page(html) -> list[dict]     # listing items + pagination
def parse_book_detail(html, slug) -> dict           # full metadata
def parse_chapter(html) -> dict | None              # {title, body}
def parse_chapter_list_page(html) -> list[dict]     # chapter links from book page

# ID registry
def load_registry() / save_registry() / get_or_create_book_id()

# Dedup
def build_existing_index() -> dict[str, dict]       # slug-based dedup across MTC + TTV + TF

# Source class
class TFSource(BookSource):
    async def fetch_book_metadata(entry) -> dict
    async def fetch_chapters(meta, existing, bundle_path) -> AsyncIterator[ChapterData]
    async def download_cover(book_id, meta, covers_dir) -> str | None
```

### Register in `src/sources/__init__.py`

```python
_REGISTRY["tf"] = "src.sources.tf"
_CLASS_NAMES["tf"] = "TFSource"
```

### Source-specific defaults in `ingest.py`

```python
_SOURCE_DEFAULTS["tf"] = {"max_concurrent": 20, "request_delay": 0.3}
```

Plan file: `data/books_plan_tf.json`

---

## HTML Selectors (from inspection)

### Listing page (`/danh-sach/truyen-hot/`)

The "Truyện Hot hoàn (full)" tab content shows books in a list. Each book:

```
Book entry container:  listing items under the "Truyện Hot hoàn (full)" section
Title:                 <h3> inside the item → <a> with href
Author:                Text element near title (author name)
Chapter count:         "Chương {N}" text
Book URL:              <a href="/{slug}-{id}/">
```

Pagination: standard `?page=N` query parameter. Last page link in pagination nav.

### Book detail page (`/{slug}-{tf_id}/`)

```
Title:          h1 (first)
Author:         Text after "Tác giả:" label
Genres:         Links after "Thể loại:" label
Status:         Text after "Trạng thái:" → "Full" / "Đang ra"
Rating:         Text pattern "N/10 từ M lượt"
Synopsis:       Long text block in description area
Cover:          <img> in info section (if any)

Chapter list:   <a> links in chapter section
                Each: "Chương N: Title" with href /{slug}-{id}/chuong-{N}/
                Paginated: 50 per page
```

### Chapter page (`/{slug}-{tf_id}/chuong-{N}/`)

```
Book title:     <h1>
Chapter title:  <h2> → "Chương 1: Sống lại"
Body:           Paragraphs between chapter navigation elements
                (NOT inside a box-chap div like TTV)
Nav:            "Chương trước" / "Chương tiếp" links
```

**Title dedup**: Unlike TTV, TF chapter pages do NOT embed the title inside the body as a duplicate `<h5>`. The `<h2>` is the sole source of truth and the body starts clean. No stripping needed.

---

## Discovery & Dedup Flow

```
1. Scrape /danh-sach/truyen-hot/ (all pages, "Truyện Hot hoàn (full)" tab)
   → ~300 completed hot books with name, author, chapter_count, URL

2. Filter: chapter_count >= 100

3. Dedup against existing DB:
   - Build slug index from books table (all sources)
   - For each TF book, slugify(name) → check if slug already exists
   - Also check by exact name match (different slugs, same book)
   - Skip if exists in MTC or TTV with status=2 (completed)

4. For remaining books:
   - Fetch book detail page → full metadata
   - Assign 30M+ offset ID via registry
   - Write plan file: data/books_plan_tf.json

5. Pull covers from book detail page cover image URL
```

### Estimated scale

- ~37,000 completed hot books across 1,384 listing pages
- After filtering ≥100 chapters: TBD (likely most qualify since these are completed novels)
- After dedup with MTC (~30K books) + TTV (~10K books): probably several thousand unique books
- Average ~500-2000 chapters per book → significant chapter volume
- Discovery is the slow part: 1,384 pages at 0.3s delay ≈ 7 minutes to scrape all listings

---

## Chapter Walk Strategy

Sequential URL iteration, same as TTV:

```
for ch_idx in range(1, chapter_count + 1):
    if ch_idx in existing_indices:
        continue
    url = f"{TF_BASE_URL}/{slug}-{tf_id}/chuong-{ch_idx}/"
    html = await client.get_html(url)
    parsed = parse_chapter(html)
    if parsed:
        yield ChapterData(index=ch_idx, title=parsed["title"], ...)
```

The chapter count comes from the listing page or book detail page. If a chapter URL returns the book detail page (redirect on missing chapter), `parse_chapter` returns `None` and it's skipped.

### Chapter title handling

The `<h2>` gives the canonical title (e.g. "Chương 1: Sống lại"). The body does NOT duplicate the title, so no stripping is needed (unlike TTV).

### Slug handling

TF URLs use `{slug}-{tf_id}` format (e.g. `than-dao-dan-ton-6060282`). Two slugs are stored:

- `tf_slug`: original URL path (`than-dao-dan-ton-6060282`) — used for fetching
- `slug`: ASCII-clean via `slugify(name)` — stored in DB for website routing

---

## Plan File Format

```json
[
  {
    "id": 30000001,
    "name": "Thần Đạo Đan Tôn",
    "slug": "than-dao-dan-ton",
    "tf_slug": "than-dao-dan-ton-6060282",
    "chapter_count": 5357,
    "status": 2,
    "status_name": "Full",
    "source": "tf",
    "author": {
      "id": 40000001,
      "name": "Cô Đơn Địa Phi"
    },
    "genres": [
      {"name": "Tiên Hiệp", "slug": "tien-hiep"},
      {"name": "Huyền Huyễn", "slug": "huyen-huyen"}
    ],
    "synopsis": "Lăng Hàn - Một Đan Đế...",
    "cover_url": "https://...",
    "review_score": 6.8,
    "review_count": 10031,
    "word_count": 0,
    "view_count": 0,
    "bookmark_count": 0,
    "vote_count": 0,
    "comment_count": 0,
    "created_at": null,
    "updated_at": null,
    "published_at": null,
    "new_chap_at": null
  }
]
```

---

## Changes to Existing Files

### `src/sources/__init__.py`

```python
_REGISTRY["tf"] = "src.sources.tf"
_CLASS_NAMES["tf"] = "TFSource"
# VALID_SOURCES becomes ("mtc", "ttv", "tf")
```

### `ingest.py`

- Add `"tf"` to `_SOURCE_DEFAULTS`
- Add `TF_DEFAULT_PLAN = SCRIPT_DIR / "data" / "books_plan_tf.json"`
- Update `default_plan` selection in `main()` for `source_name == "tf"`

### `generate_plan.py`

- Add `TF_PLAN_FILE` constant
- Add `run_generate_tf()` function (scrape hot listing → plan)
- Add `run_refresh_tf()` function (re-fetch metadata from detail pages)
- Add `run_cover_pull_tf()` function
- Route `--source tf` in `main()`

### `repair_titles.py`

- Add `--source tf` support in `run_repair_ttv()` (reuse with TF, or add `run_repair_tf()`)
- TF chapters likely have clean titles from `<h2>`, so repair may not be needed initially

### `.gitignore`

- `data/books_plan_tf.json` and `data/book_registry_tf.json` already covered by `data/books_plan_*.json` and `data/book_registry_*.json` globs

### `requirements.txt`

- No new dependencies (beautifulsoup4 + lxml already added for TTV)

---

## UI Changes (binslib)

### Source Switcher → Dropdown Menu

The current source switcher is a binary toggle (`MTC ⬤ TTV`) that only supports two sources. With three sources it must become a **dropdown menu** styled like the existing "Danh mục" category dropdown.

**Current** (`SourceToggle.tsx`):
```
MTC [●———] TTV          ← binary toggle, click to flip
```

**New** (`SourceSelector.tsx`):
```
📚 Nguồn ▾              ← dropdown trigger (icon + label + chevron)
┌──────────────────────┐
│  📘  MTC       ✓     │ ← active source highlighted
│  📗  TTV              │
│  📙  TruyenFull       │
└──────────────────────┘
```

#### Design specs

- **Trigger button**: icon + "Nguồn" (or current source name) + chevron, same styling as "Danh mục" button
- **Dropdown panel**: absolute positioned, `z-50`, rounded shadow border — reuse the same CSS pattern as `CategoryDropdown.tsx`
- **Each item**: source icon + source label + checkmark for active; hover highlights with source accent color
- **Click behaviour**: sets `book_source` cookie, calls `router.refresh()`, closes dropdown (same as current `setSource()`)
- **Close on**: click outside, Escape key (same as `CategoryDropdown`)
- **Mobile**: include in mobile nav menu alongside the category list

#### Source icons and accent colors

| Source | Short name | Icon | Accent color | Description |
|---|---|---|---|---|
| `mtc` | MTC | 📘 or custom SVG (book with lock) | `blue-500` | metruyencv — encrypted API |
| `ttv` | TTV | 📗 or custom SVG (book with globe) | `emerald-500` | tangthuvien — HTML scraping |
| `tf` | TruyenFull | 📙 or custom SVG (book with star) | `amber-500` | truyenfull — hot completed books |

Use inline SVG icons (not emoji) for consistency with the rest of the UI. Each icon should be a 16×16 or 20×20 SVG with `stroke="currentColor"`.

#### Files to change

| File | Change |
|---|---|
| `SourceContext.tsx` | Add `"tf"` to `BookSource` type; remove `toggle()` (no longer binary); keep `setSource()` |
| `SourceToggle.tsx` | **Delete** — replaced by `SourceSelector.tsx` |
| `SourceSelector.tsx` | **New** — dropdown component with source list, icons, active indicator |
| `Header.tsx` | Replace `<SourceToggle />` with `<SourceSelector />` |
| `layout.tsx` | Update `BookSource` type to include `"tf"`, update cookie default logic |
| `lib/source.ts` | Update `getSource()` to handle `"tf"` cookie value |
| `lib/queries.ts` | Update `BookSource` type to `"mtc" | "ttv" | "tf"` |

#### SourceContext changes

```typescript
// Before
export type BookSource = "mtc" | "ttv";
const toggle = () => setSource(source === "mtc" ? "ttv" : "mtc");

// After
export type BookSource = "mtc" | "ttv" | "tf";
// toggle() removed — dropdown calls setSource() directly
```

### "Danh mục" Genre Icons Update

The `CategoryDropdown.tsx` has a `GENRE_ICONS` map with SVG path data for ~18 genres. Many genres are missing icons (they render nothing). Update to:

1. **Add icons for all genres** in the DB — currently ~43 genres across all sources, only ~18 have icons
2. **Add a fallback icon** (generic book/tag icon) for genres not in the map, so every genre row has an icon
3. **Use consistent icon style** — all 24×24 viewBox, `strokeWidth={1.5}`, `strokeLinecap="round"`, `strokeLinejoin="round"`

#### Genre icon additions needed

Inspect the DB for all genre slugs and add missing icons:

```typescript
// Existing (keep)
"tien-hiep", "huyen-huyen", "do-thi", "khoa-huyen", "vong-du",
"dong-nhan", "da-su", "canh-ky", "kiem-hiep", ...

// Missing (add)
"ngon-tinh":      heart icon
"dam-my":         two-people icon
"quan-truong":    building/gavel icon
"he-thong":       chip/cog icon
"di-gioi":        portal/world icon
"di-nang":        lightning/power icon
"quan-su":        shield/military icon
"lich-su":        clock/scroll icon
"xuyen-khong":    time-travel/wormhole icon
"trong-sinh":     cycle/rebirth icon
"linh-di":        ghost/spirit icon
"mat-the":        skull/apocalypse icon
"truyen-teen":    user/youth icon
"viet-nam":       flag icon
"hai-huoc":       smile/laugh icon
...

// Fallback for any unknown genre
DEFAULT_ICON:     generic tag/bookmark icon
```

#### Files to change

| File | Change |
|---|---|
| `CategoryDropdown.tsx` | Expand `GENRE_ICONS` map to cover all genres; add `DEFAULT_ICON` fallback in `GenreIcon` component |

---

## Implementation Order

1. **`src/sources/tf.py`** — HTTP client, HTML parsers, registry, dedup, `TFSource` class
2. **`src/sources/__init__.py`** — Register `tf`
3. **`generate_plan.py`** — Add `run_generate_tf()`, `run_refresh_tf()`, `run_cover_pull_tf()`
4. **`ingest.py`** — Add `tf` to defaults, plan file path
5. **Test**: `python3 generate_plan.py --source tf --dry-run`
6. **Test**: `python3 ingest.py --source tf --dry-run`
7. **Test**: `python3 ingest.py --source tf <book_id>` (single book, real ingest)
8. **UI: `SourceSelector.tsx`** — New dropdown component replacing `SourceToggle.tsx`
9. **UI: `SourceContext.tsx`** — Add `"tf"` to `BookSource` type, remove `toggle()`
10. **UI: `CategoryDropdown.tsx`** — Expand genre icons, add fallback icon
11. **UI: Backend types** — Update `BookSource` in `queries.ts`, `source.ts`, `layout.tsx`

---

## Usage

```bash
cd book-ingest

# ── Plan generation ──────────────────────────────────
# Scrape hot completed books, dedup, write plan
python3 generate_plan.py --source tf

# Dry run
python3 generate_plan.py --source tf --dry-run

# Refresh existing plan with latest metadata
python3 generate_plan.py --source tf --refresh

# Covers only
python3 generate_plan.py --source tf --cover-only

# ── Ingest ───────────────────────────────────────────
# Ingest all from plan
python3 ingest.py --source tf -w 3

# Specific book
python3 ingest.py --source tf 30000001

# Force re-download
python3 ingest.py --source tf --force 30000001
```

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Rate limiting / IP ban | Medium | Conservative delay (0.3s), retry with backoff, max 20 concurrent |
| HTML structure changes | Low | Parsers are modular; update selectors as needed |
| Chapter URL doesn't exist | Medium | `parse_chapter` returns `None`, skip silently (same as TTV) |
| Books overlap with MTC/TTV | High | Slug-based + name-based dedup during plan generation |
| Chapter numbering gaps | Low | Sequential walk, skip missing indices |
| "Full" books with missing chapters | Medium | Ingest what's available, log warnings for missing |
| Cover images behind CDN/hotlink protection | Low | Download with browser-like headers; fallback to no cover |

---

## Data Flow

```
TF path:
  generate_plan.py --source tf  →  data/books_plan_tf.json
  ingest.py --source tf         →  HTML → parse → compress → bundle + DB

Output (same as MTC/TTV):
  ├── binslib/data/compressed/{book_id}.bundle   (BLIB v2)
  ├── binslib/data/binslib.db                    (SQLite, source="tf")
  └── binslib/public/covers/{book_id}.jpg
```

---

## Verification Tests

### Smoke tests (manual, real network)

```bash
# 1. Plan generation
python3 generate_plan.py --source tf --dry-run
# Verify: prints discovered books, dedup stats, no files written

# 2. Generate real plan
python3 generate_plan.py --source tf
# Verify: data/books_plan_tf.json exists, entries have source/slug/chapter_count

# 3. Single book ingest
python3 ingest.py --source tf 30000001 --dry-run
# Verify: metadata fetched, chapter count shown

python3 ingest.py --source tf 30000001 -w 1
# Verify:
#   binslib/data/compressed/30000001.bundle exists
#   sqlite3 binslib/data/binslib.db "SELECT id, name, source FROM books WHERE id=30000001"
#   → source='tf'

# 4. Batch ingest
python3 ingest.py --source tf --limit 5 -w 3
# Verify: 5 bundles, 5 book rows with source='tf'

# 5. Website access
# Open http://localhost:3000/doc-truyen/{slug} — book page loads
```

### Unit tests (to add)

- `parse_hot_listing_page()` with saved HTML fixture
- `parse_book_detail()` with saved HTML fixture
- `parse_chapter()` with saved HTML fixture — verify title from `<h2>`, body clean (no title dup)
- `_extract_tf_id("than-dao-dan-ton-6060282")` → `6060282`
- Dedup logic: book exists in MTC → skipped; book exists in TTV → skipped; new book → included
- Registry round-trip: slug → ID → same ID on second call

### UI tests (manual)

- Source dropdown opens/closes on click, closes on Escape and click-outside
- Each source item shows icon + label; active source has checkmark
- Clicking a source sets cookie, refreshes page, dropdown closes
- Genre dropdown shows icons for all genres (no blank icon slots)
- Genres without a specific icon show the fallback icon
- Mobile nav includes source selector