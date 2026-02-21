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

## Endpoints

### 1. Book Ranking

```
GET /api/books/ranking?gender=1&kind=1&type=view&year=2026&month=2&limit=10&page=1
```

**Query Parameters:**

| Param  | Value | Description      |
| ------ | ----- | ---------------- |
| gender | 1     | Gender category  |
| kind   | 1     | Book kind        |
| type   | view  | Ranking type     |
| year   | 2026  | Year             |
| month  | 2     | Month            |
| limit  | 10    | Results per page |
| page   | 1     | Page number      |

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
        "kind": 1,
        "sex": 1,
        "state": "Đã xuất bản",
        "status": 1,
        "link": "https://metruyencv.com/truyen/...",
        "first_chapter": 23671918,
        "latest_chapter": 26882502,
        "latest_index": 1047,
        "poster": {
          "default": "...",
          "600": "...",
          "300": "...",
          "150": "..."
        },
        "synopsis": "...",
        "vote_count": 17559,
        "review_score": "4.927",
        "chapter_count": 1047,
        "word_count": 2216818,
        "bookmark_count": 6618,
        "creator": { "id": 1000065, "name": "..." },
        "author": { "id": 24942, "name": "...", "local_name": "..." },
        "genres": [{ "id": 3, "name": "Huyền Huyễn" }]
      }
    }
  ],
  "pagination": {
    "current": 1,
    "next": 2,
    "prev": null,
    "last": 10,
    "limit": 10,
    "total": 100
  },
  "success": true,
  "status": 200
}
```

### 2. Book Search (exact match)

```
GET /api/books?filter[keyword]=<search_term>&include=author,creator,genres
```

**Query Parameters:**

| Param            | Value         | Description                        |
| ---------------- | ------------- | ---------------------------------- |
| filter[keyword]  | search term   | Exact keyword match on book name   |
| include          | author,...    | Related resources to include       |

- Returns books whose name matches the keyword exactly
- Diacritics-insensitive: `"hu bai the gioi"` matches `"Hu Bai The Gioi"` (but NOT `"Hu Bai Thê Gioi"` — needs exact tones for exact match)

### 3. Book Search (fuzzy)

```
GET /api/books/search?keyword=<search_term>
```

**Query Parameters:**

| Param   | Value       | Description                     |
| ------- | ----------- | ------------------------------- |
| keyword | search term | Fuzzy keyword match on books    |

- Returns fuzzy matches — more results, less precise
- Useful when you don't know the exact title

### 4. Book Details

```
GET /api/books?filter[author]=24942&filter[state]=published&include=author,creator,genres
```

**Response:** Same book structure as ranking but without the ranking wrapper.

### 5. Chapter Content

```
GET /api/chapters/{chapter_id}
```

**Response:**

```json
{
  "status": 200,
  "success": true,
  "data": {
    "id": 23671918,
    "name": "Chương 01: Loạn thế",
    "index": 1,
    "slug": "chuong-01-loan-the",
    "book_id": 144812,
    "content": "<chapter text content encrypted>",
    "unlock_price": 0,
    "is_locked": 0,
    "object_type": "Chapter",
    "book": {
      "id": 144812,
      "name": "Cẩu Tại Võ Đạo Thế Giới Thành Thánh",
      "slug": "cau-tai-vo-dao-the-gioi-thanh-thanh"
    }
  }
}
```

## x-signature Analysis

**RESULT: Not validated server-side. Can be omitted entirely.**

Tested on 2026-02-15:
- Same signature on same endpoint → 200 OK
- Same signature on different chapter → 200 OK
- Same signature on entirely different endpoint → 200 OK
- No signature at all → 200 OK

Only the Bearer token matters for authentication.

## Notes

- All responses are JSON with `{ "data": ..., "success": true, "status": 200 }` wrapper
- Pagination uses `page` and `limit` params
- Chapter `content` field is **encrypted** (AES-CBC in Laravel envelope format) — see `ENCRYPTION.md`
- Books have `first_chapter` and `latest_index` fields useful for iterating all chapters
- Chapter responses include a `next` field with the next chapter's `id`, `name`, `index` — enables sequential traversal without a chapter list endpoint
- Cloudflare is in front of the API (CF-RAY headers present)
