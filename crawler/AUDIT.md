# Book Download Audit

Updated: 2026-02-21

## Platform Catalog

The MTC platform has **30,486 total books** (30,438 downloadable, 48 with no chapters).

Full catalog fetched via paginating `/api/books` (610 pages × 50 books).
Saved to `crawler-descryptor/full_catalog.json`.

## Current Coverage

| Status | Books | Chapters |
| --- | ---: | ---: |
| In DB (complete, ≥95% chapters) | 2,455 | ~1,482,830 |
| In DB (partial, <95% chapters) | 360 | ~407,533 gap |
| Not downloaded | 27,623 | ~12,405,037 |
| Not downloadable (no chapters/API) | 48 | 0 |
| **Platform total** | **30,486** | **~14,300,000** |

### Coverage breakdown

- **8.1%** of the platform catalog is downloaded (2,815 of 30,438 downloadable books)
- **1,482,830 chapters** are in the SQLite database (`binslib/data/binslib.db`)
- **12.8M chapters** remain to be fetched

### Database stats

```
Books in DB:    3,478
Chapters in DB: 1,482,830
DB size:        ~39 GB (binslib/data/)
```

## Download History

### Phase 1 — Original crawler (emulator-based)

- Method: Automated emulator UI + local DB extraction
- Books: ~285 (manually triggered via `grab_book.py`)
- Chapters: ~276,003
- Output: `crawler/output/{book_id}/metadata.json` + `.txt` files (cleaned up after import)

### Phase 2 — API decryption (crawler-descryptor)

- Method: Direct API calls with AES-128-CBC decryption
- Books: ~2,620 (from ranking API sweep across 14 months × 3 types × 3 categories)
- Chapters: ~1,468,564
- Workers: 100 concurrent, 120 max API requests, 0.02s delay
- Scripts: `batch_download.py`, `download_top1000.py`
- Plan file: `ranking_books.json`

### Phase 3 — Full catalog download (not yet started)

- Full catalog: `full_catalog.json` (30,486 books)
- Download plan: `new_books_download.json` (27,623 books, ~12.4M chapters)
- Partial plan: `partial_books_download.json` (360 books, ~407K chapters to fill)
- Estimated time: ~24 hours at 150 ch/s with 100 workers
- Script: `python3 download_top1000.py -w 100 --plan new_books_download.json`

## Previously Downloaded Books (Phase 1)

The original web-crawler downloaded 278 complete + 7 empty-folder books via the
emulator automation pipeline. These are now in the SQLite database. See the
`metadata.json` files in `crawler/output/` for individual book details.

## Verification

Author "Cổn khai" (ID 926) has 7 books on the platform — confirmed present in full catalog:

| ID | Chapters | Name |
| ---: | ---: | --- |
| 148610 | 269 | Hủ Bại Thế Giới |
| 128384 | 625 | Tuyệt Cảnh Hắc Dạ |
| 117669 | 721 | Góc Chết Bí Ẩn |
| 111137 | 755 | Ta Thuộc Tính Tu Hành Nhân Sinh |
| 105561 | 884 | Thập Phương Võ Thánh |
| 101425 | 499 | Vạn Thiên Chi Tâm |
| 101052 | 1213 | Cực Đạo Thiên Ma |
