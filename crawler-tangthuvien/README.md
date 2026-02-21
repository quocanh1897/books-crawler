# crawler-tangthuvien

Crawl book data from [truyen.tangthuvien.vn](https://truyen.tangthuvien.vn/) — a Vietnamese web novel platform.

## How It Works

Unlike crawler-descryptor (which decrypts AES-encrypted API responses from metruyencv), tangthuvien serves content as plain HTML. This crawler:

1. **Discovers** top books by scraping the `/tong-hop` filter page (sorted by views/recency)
2. **Deduplicates** against MTC's `crawler/output/` — skips books already downloaded and completed
3. **Fetches** book metadata from `/doc-truyen/{slug}` detail pages
4. **Downloads** chapter content from `/doc-truyen/{slug}/chuong-{N}` pages
5. **Outputs** in the same format as crawler-descryptor for binslib compatibility

|           | crawler-descryptor (MTC)  | crawler-tangthuvien (TTV)     |
| --------- | ------------------------- | ----------------------------- |
| Source    | metruyencv.net mobile API | truyen.tangthuvien.vn HTML    |
| Content   | AES-128-CBC encrypted     | Plain HTML                    |
| Book IDs  | Native numeric (< 1M)     | Generated (10M+ offset)       |
| Discovery | Ranking API sweep         | HTML scraping of filter pages |
| Auth      | Bearer token              | None (public)                 |

---

## Setup

```bash
cd crawler-tangthuvien
pip install -r requirements.txt
```

## Usage

### Discover top books

```bash
python discover.py                    # top 1000 by views (50 pages × ~20/page)
python discover.py --pages 10         # top ~200 books
python discover.py --no-dedup         # skip MTC dedup check
```

Outputs `books_to_crawl.json` with book slugs, names, and basic metadata.

### Fetch a single book

```bash
python main.py fetch-book muc-than-ky
python main.py fetch-book muc-than-ky --delay 2.0   # slower rate
```

### Batch download all discovered books

```bash
python batch_download.py                      # 3 concurrent workers
python batch_download.py -w 5                 # 5 workers
python batch_download.py --limit 100          # first 100 books only
python batch_download.py --reset              # re-download everything
```

Progress is tracked in `download_status.json` — interrupted downloads resume automatically.

### CLI entry point

```bash
python main.py discover --pages 50
python main.py fetch-book quy-bi-chi-chu
```

### Output

Chapters are saved to `output/{book_id}/` in the same format as `crawler/output/`:

```
output/{book_id}/
├── 0001_chuong-1.txt       # "{title}\n\n{body}"
├── 0002_chuong-2.txt
├── ...
├── cover.jpg
└── metadata.json
```

Compatible with `binslib/scripts/import.ts` when configured with `TTV_CRAWLER_OUTPUT_DIR`.

## ID Strategy

TTV books use a 10,000,000+ offset for IDs to avoid collisions with MTC book IDs. The mapping is stored in `book_registry.json`:

```json
{
  "muc-than-ky": 10000001,
  "quy-bi-chi-chu": 10000002
}
```

## MTC Deduplication

During discovery, each book slug is checked against `crawler/output/*/metadata.json`. If a matching slug exists and the MTC book has `status == 2` (completed), it is skipped. This avoids re-downloading completed books that are already in the MTC dataset.

## Project Structure

```
crawler-tangthuvien/
├── README.md                     # This file
├── PLAN.md                       # Architecture and design plan
├── requirements.txt              # httpx, beautifulsoup4, lxml
├── config.py                     # Base URL, headers, rate limits, ID offset
├── main.py                       # CLI: discover, fetch-book
├── discover.py                   # Scrape listings, dedup vs MTC, output book list
├── batch_download.py             # Async parallel batch download
├── book_registry.json            # slug -> numeric ID mapping (auto-generated)
├── books_to_crawl.json           # Discovered book list (auto-generated)
├── download_status.json          # Batch download progress (auto-generated)
├── src/
│   ├── client.py                 # HTTP client with throttling + retries
│   ├── parser.py                 # HTML parsers (listings, book detail, chapters)
│   └── utils.py                  # Output helpers, registry, MTC dedup index
├── output/                       # Crawled data (gitignored)
│   └── {book_id}/
│       ├── metadata.json
│       ├── cover.jpg
│       └── *.txt
└── tests/
    └── test_parser.py
```
