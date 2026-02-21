# crawler-tangthuvien — Plan

## Problem

The MTC crawler (crawler-descryptor) sources books from metruyencv.net. [truyen.tangthuvien.vn](https://truyen.tangthuvien.vn/) is a separate Vietnamese web novel platform with a large catalog (~10K+ books across 12 genres). Adding tangthuvien as a data source expands the binslib library significantly.

**Goal**: Build a crawler for tangthuvien that outputs data in the same format as crawler-descryptor, enabling binslib to import from both sources with minimal changes.

## What We Know

### Site Structure

- **Listing/filter page**: `/tong-hop?tp=cv&ctg=0&page=N` — paginated book listings, ~20 books/page, 494 pages total
- **Book detail page**: `/doc-truyen/{slug}` — metadata, stats, chapter list (first 75 chapters, JS pagination for the rest)
- **Chapter page**: `/doc-truyen/{slug}/chuong-{N}` — chapter title and body in plain HTML
- **Genre pages**: `/the-loai/{slug}` — per-genre rankings
- **Author pages**: `/tac-gia?author={id}` — author info

### Key Differences from MTC

| Aspect | MTC (crawler-descryptor) | TTV (this project) |
|--------|--------------------------|---------------------|
| Data access | Mobile API (JSON) | Web scraping (HTML) |
| Content | AES-128-CBC encrypted | Plain text in HTML |
| Book IDs | Numeric (native) | Slug-based (need ID mapping) |
| Chapter traversal | API `next` field chaining | Sequential URL iteration |
| Auth | Bearer token required | Public, no auth |

### HTML Structure (Key Selectors)

- **Listing item**: `div.rank-view-list li` > `div.book-mid-info h4 a` (title), `p.author a.name` (author), `p.author span` (status/chapters)
- **Book detail**: `div.book-info h1` (title), `p.tag a[href*=tac-gia]` (author), `span.ULtwOOTH-view` (views), `span.ULtwOOTH-like` (favorites)
- **Chapter content**: `h2` (title), `div.box-chap` (body text)
- **Chapter list pagination**: JavaScript `Loading(N)` calls, backed by AJAX

## Approach: Three Phases

### Phase 1 — Book Discovery

Scrape `/tong-hop` filter pages to build a list of top books.

- Pages sorted by most recently updated (default)
- 50 pages × ~20 books = ~1000 books for the first milestone
- Deduplication against MTC `crawler/output/` (skip completed books)
- Output: `books_to_crawl.json`

### Phase 2 — Crawl Books

For each book in the list:

1. Fetch book detail page → parse metadata
2. Download cover image
3. Iterate chapters sequentially (`chuong-1` through `chuong-{total}`)
4. Parse chapter HTML → extract title and body text
5. Save in crawler-descryptor output format

### Phase 3 — Binslib Integration

- Add `TTV_CRAWLER_OUTPUT_DIR` to binslib's import script
- Scan both directories, merge entries
- No schema changes needed (metadata maps directly)

## Tech Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| Language | Python 3.9+ | Matches crawler-descryptor |
| HTTP | httpx | Sync + async, already used in MTC |
| HTML parsing | BeautifulSoup4 + lxml | Fast, robust HTML parsing |
| CLI | argparse | No extra deps |
| Async | asyncio | Parallel batch downloads |

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Rate limiting / IP ban | Medium | Conservative delay (1.5s), retry with backoff |
| HTML structure changes | Low | Parsers are modular; update selectors as needed |
| Chapter URL inconsistency | Medium | Try sequential chuong-N; fall back to chapter list |
| ID collision with MTC | Must avoid | 10M+ offset for TTV IDs |
| Incomplete chapter lists (JS pagination) | Medium | Sequential iteration instead of relying on page chapter list |
| Duplicate books across MTC and TTV | Expected | Slug-based dedup; skip MTC-completed books |

## Milestones

### Milestone 1: Top 1000 Books by Views ✅

1. `python discover.py --pages 50` → 990 books (after MTC dedup)
2. `python batch_download.py -w 50 --delay 0.05 --max-concurrent 25` → downloaded all
3. Updated binslib import to scan TTV output
4. Verified import works end-to-end

**Results**: 990 books, 963,624 chapters saved, ~2h runtime on server

### Milestone 2: All Remaining Books

Download every book on tangthuvien that isn't already in the binslib DB.

1. `python discover.py --pages 600 -o books_to_crawl_all.json` → 9,805 books (63 MTC dupes skipped)
2. `python batch_download.py -w 50 --delay 0.05 --max-concurrent 25 --input books_to_crawl_all.json`
3. batch_download skips 990 M1 books via download_status.json
4. Net new: 8,815 books to download

**Breakdown**: 5,001 ongoing + 3,993 completed + 811 unknown status

### Future Milestones

- Periodic re-crawl of ongoing books (new chapters)
- Retry failed VIP chapters if access changes

## Execution Order

1. Project scaffold (config, client, utils)
2. HTML parsers (listing, book detail, chapter)
3. Discovery script (top-by-views)
4. Single book fetch (main.py fetch-book)
5. Batch download (batch_download.py)
6. Binslib integration (import.ts update)
7. Documentation (README, PLAN, SPEC update)
