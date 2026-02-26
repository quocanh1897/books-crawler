# MTC API Documentation

## Base URL

`https://android.lonoapp.net`

## Common Headers

```
authorization: Bearer 7045826|W0GmBOqfeWO0wWZUD7QpikPjvMsP1tq7Ayjq48pX
x-app: app.android
user-agent: Dart/3.5 (dart:io)
content-type: application/json
```

Note: `x-signature` header is NOT validated — can be omitted entirely.
Only the Bearer token matters for authentication.

## Endpoints

### 1. Book by ID (direct fetch) ⭐ Recommended

```
GET /api/books/{book_id}?include=author,creator,genres
```

The **most reliable** way to fetch book data. Works for any valid book ID even when the listing and search endpoints fail to surface it.

**Response:**

```json
{
  "status": 200,
  "success": true,
  "data": {
    "book": {
      "id": 101380,
      "name": "Quỷ Bí Chi Chủ",
      "slug": "quy-bi-chi-chu",
      "kind": 1,
      "sex": 1,
      "status": 1,
      "status_name": "Còn tiếp",
      "first_chapter": 11473202,
      "latest_chapter": 15570764,
      "latest_index": 1414,
      "chapter_count": 1412,
      "word_count": 4185916,
      "view_count": 81736,
      "vote_count": 2942,
      "bookmark_count": 1754,
      "comment_count": 572,
      "review_score": "4.625",
      "review_count": 48,
      "synopsis": "...",
      "poster": {
        "default": "https://static.cdnno.com/poster/quy-bi-chi-chu/default.jpg?...",
        "600": "...", "300": "...", "150": "..."
      },
      "created_at": "2018-04-03T09:04:19.000000Z",
      "updated_at": "2026-06-09T...",
      "published_at": "...",
      "author": { "id": 24942, "name": "...", "local_name": "..." },
      "creator": { "id": 1000043, "name": "KOL" },
      "genres": [{ "id": 3, "name": "Huyền Huyễn", "slug": "huyen-huyen" }]
    }
  }
}
```

**ID range:** All valid MTC book IDs fall within **100003–~153200**. IDs outside this range return 404. Not every ID in the range is valid — density is ~78% in dense regions, ~26% in sparse gaps.

### 2. Book Listing

```
GET /api/books?limit=50&page=1
```

**Query Parameters:**

| Param            | Value       | Description                                |
| ---------------- | ----------- | ------------------------------------------ |
| limit            | 1–50        | Results per page                           |
| page             | 1+          | Page number                                |
| sort             | id, view_count, chapter_count, etc. | Sort field        |
| filter[keyword]  | string      | Exact keyword match on book name           |
| filter[author]   | int         | Filter by author ID                        |
| filter[state]    | published, ongoing, completed | Filter by state     |
| filter[status]   | 1, 2, 3     | 1=ongoing, 2=completed, 3=paused           |
| filter[kind]     | 1–5         | Book kind (has no effect on total)         |
| include          | author,creator,genres | Related resources to include     |

> ⚠️ **LIMITATION: Hard-capped at ~402 results.** Regardless of filters, sort order, or pagination, this endpoint never returns more than ~402 books total. This misses the vast majority of the ~31,000+ books on the platform. Use direct ID fetch (endpoint 1) for comprehensive coverage.

### 3. Book Search (exact match)

```
GET /api/books?filter[keyword]=<search_term>&include=author,creator,genres
```

- Diacritics-insensitive: `"hu bai the gioi"` matches `"Hu Bai The Gioi"`
- But needs exact tones for tonal distinction

> ⚠️ **LIMITATION: Many valid books are invisible to search.** For example, "Goblin Trọng Độ Ỷ Lại" (id=137544) and "Hủ Bại Thế Giới" (id=148610) return 0 results from search but are fully accessible by direct ID fetch.

### 4. Book Search (fuzzy)

```
GET /api/books/search?keyword=<search_term>
```

- Returns fuzzy matches — more results, less precise
- Same visibility limitation as exact search — misses many valid books

### 5. Book Ranking

```
GET /api/books/ranking?gender=1&kind=1&type=view&year=2026&month=2&limit=10&page=1
```

**Query Parameters:**

| Param  | Value              | Description           |
| ------ | ------------------ | --------------------- |
| gender | 1, 2               | Gender category       |
| kind   | 1                  | Book kind             |
| type   | view, vote, comment | Ranking type (see below) |
| year   | int                | Year                  |
| month  | int                | Month                 |
| limit  | int                | Results per page      |
| page   | int                | Page number           |

**Valid ranking types:** `view` (total ~53), `vote` (total ~91), `comment` (total ~100).

**Invalid types** (return validation error): `review`, `bookmark`, `chapter`, `nominate`.

**Response:**

```json
{
  "data": [
    {
      "id": 44670,
      "ranking": 1,
      "type": "view",
      "kind": 1,
      "book": {
        "id": 144812,
        "name": "Cẩu Tại Võ Đạo Thế Giới Thành Thánh",
        "slug": "cau-tai-vo-dao-the-gioi-thanh-thanh",
        "first_chapter": 23671918,
        "latest_chapter": 26882502,
        "latest_index": 1047,
        "chapter_count": 1047,
        "word_count": 2216818,
        "...": "..."
      }
    }
  ],
  "pagination": { "current": 1, "next": 2, "prev": null, "last": 10, "limit": 10, "total": 100 },
  "success": true,
  "status": 200
}
```

### 6. Chapter Content (single)

```
GET /api/chapters/{chapter_id}
```

**Response:**

```json
{
  "status": 200,
  "success": true,
  "data": {
    "id": 11473202,
    "name": "Chương 1: ửng đỏ",
    "index": 1,
    "slug": "chuong-1-ung-do",
    "book_id": 101380,
    "word_count": 3171,
    "content": "<AES-128-CBC encrypted — see ENCRYPTION.md>",
    "unlock_price": 0,
    "is_locked": 0,
    "object_type": "Chapter",
    "next": {
      "id": 11473203,
      "name": "Chương 2: Tình huống",
      "index": 2,
      "created_at": "2018-04-03T09:04:19.000000Z",
      "object_type": "Chapter"
    },
    "previous": null,
    "book": {
      "id": 101380,
      "name": "Quỷ Bí Chi Chủ",
      "slug": "quy-bi-chi-chu"
    }
  }
}
```

**Chapter title format:** The `name` field **always** includes a `"Chương X:"` prefix (e.g., `"Chương 1: ửng đỏ"`, `"Chương 01: Loạn thế"`). This is the canonical title.

**Decrypted content format:** The encrypted `content`, once decrypted, **always** starts with the chapter title as line 0, followed by a blank line, then the actual body text:

```
Chương 1: ửng đỏ        ← title embedded as line 0
                         ← blank line
đau                      ← actual story content starts here

đau quá!
```

**Chapter traversal:** The `next` and `previous` fields enable walking the chapter chain without a chapter list. Each contains `{id, name, index}` of the adjacent chapter, or `null` at the boundaries.

### 7. Chapter Listing (bulk) ⭐ Discovered

```
GET /api/chapters?filter[book_id]={book_id}&limit=100000
```

Returns **all** chapter metadata for a book in a single request. No content, no encrypted data — just names, indices, and IDs. Extremely efficient for title repair and catalog operations.

**Response:**

```json
{
  "status": 200,
  "success": true,
  "data": [
    {
      "id": 11473202,
      "name": "Chương 1: ửng đỏ",
      "index": 1,
      "word_count": 3171,
      "view_count": 7400,
      "user_id": 1000043,
      "published_at": "2018-04-03T09:04:19.000000Z",
      "unlock_price": 0,
      "unlock_key_price": 0,
      "is_locked": 0,
      "object_type": "Chapter"
    },
    {
      "id": 11473203,
      "name": "Chương 2: Tình huống",
      "index": 2,
      "...": "..."
    }
  ],
  "pagination": {},
  "success": true
}
```

**Notes:**
- Returns the full list regardless of `limit` — pagination fields are empty
- Does **not** include `slug`, `content`, `next`, or `previous` fields
- Does **not** include `book` nested object
- Used by `repair_titles.py` and `refresh_catalog.py`

## x-signature Analysis

**RESULT: Not validated server-side. Can be omitted entirely.**

Tested on 2026-02-15:
- Same signature on same endpoint → 200 OK
- Same signature on different chapter → 200 OK
- Same signature on entirely different endpoint → 200 OK
- No signature at all → 200 OK

## Known Limitations & Gotchas

### Listing/search endpoints miss most books

The `/api/books` listing is hard-capped at ~402 results. The search endpoints (`filter[keyword]` and `/api/books/search`) also fail to find many valid books. Out of ~31,000+ books on the platform, these endpoints only expose a small fraction.

**Workaround:** Scan the ID range 100003–153200 directly via `GET /api/books/{id}`. This is how `refresh_catalog.py --scan` discovers all books.

### Chapter title is embedded in encrypted content

The decrypted body text always starts with the chapter title (e.g., `"Chương 1: ửng đỏ"`) as its first line. When extracting body text, **strip this line** to avoid duplication with the `name` field. The `name` field from the API is the canonical title — never extract titles from the decrypted body.

### ID range

| Range         | Result |
| ------------- | ------ |
| < 100003      | 404    |
| 100003–153184 | Valid (with gaps — ~78% density in dense regions) |
| > ~153184     | 404    |

The upper bound grows as new books are added to the platform.

## Notes

- All responses are JSON with `{ "data": ..., "success": true, "status": 200 }` wrapper
- Pagination uses `page` and `limit` params (where applicable)
- Chapter `content` field is **encrypted** (AES-128-CBC in Laravel envelope format) — see `ENCRYPTION.md`
- Books have `first_chapter` and `latest_chapter` fields useful for chapter chain traversal
- Cloudflare is in front of the API (CF-RAY headers present)
- The `data` field for single-book responses may be wrapped differently depending on params — can be `{book: {...}}`, `[{book: {...}}]`, or a flat book object. Always normalize.