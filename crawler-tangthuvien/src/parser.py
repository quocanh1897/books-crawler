"""HTML parsers for tangthuvien pages."""
from __future__ import annotations

import re
from html import unescape
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

BASE = "https://truyen.tangthuvien.vn"


# ---------------------------------------------------------------------------
# Listing / ranking page parser  (/tong-hop)
# ---------------------------------------------------------------------------

def parse_listing_page(html: str) -> list[dict]:
    """Parse a /tong-hop listing page and extract book entries.

    Returns a list of dicts with keys:
        slug, name, author_name, author_id, genre, status, chapter_count,
        synopsis, updated_at, cover_url, ttv_book_id
    """
    soup = BeautifulSoup(html, "lxml")
    books: list[dict] = []

    items = soup.select("div.rank-view-list li")
    for li in items:
        try:
            book = _parse_listing_item(li)
            if book:
                books.append(book)
        except Exception:
            continue
    return books


def parse_listing_total_pages(html: str) -> int:
    """Extract the total number of pages from the pagination on a listing page."""
    soup = BeautifulSoup(html, "lxml")
    pages = soup.select("div.pagination ul.pagination li a")
    max_page = 1
    for a in pages:
        href = a.get("href", "")
        m = re.search(r'page=(\d+)', str(href))
        if m:
            max_page = max(max_page, int(m.group(1)))
    return max_page


def _parse_listing_item(li: Tag) -> dict | None:
    """Parse a single <li> book item from the listing page."""
    title_a = li.select_one("div.book-mid-info h4 a")
    if not title_a:
        return None

    href = title_a.get("href", "")
    slug = _extract_slug(href)
    name = title_a.get_text(strip=True)

    author_a = li.select_one("p.author a.name")
    author_name = author_a.get_text(strip=True) if author_a else ""
    author_id = _extract_author_id(author_a.get("href", "")) if author_a else None

    genre_a = li.select_one("p.author a[href*='the-loai']")
    genre = genre_a.get_text(strip=True) if genre_a else ""

    status_spans = li.select("p.author > span")
    status_text = ""
    chapter_count = 0
    for span in status_spans:
        text = span.get_text(strip=True)
        if "chương" in text:
            m = re.search(r'(\d+)', text)
            if m:
                chapter_count = int(m.group(1))
        elif text in ("Đang ra", "Đã hoàn thành", "Hoàn thành", "Tạm dừng"):
            status_text = text

    # Some chapter counts are in spans with obfuscated class names inside the status span
    if chapter_count == 0:
        for span in li.select("p.author span span"):
            text = span.get_text(strip=True)
            if text.isdigit():
                chapter_count = int(text)
                break

    intro_p = li.select_one("p.intro")
    synopsis = intro_p.get_text(strip=True) if intro_p else ""

    update_span = li.select_one("p.update span")
    updated_at = update_span.get_text(strip=True) if update_span else ""

    img = li.select_one("div.book-img-box img")
    cover_url = img.get("src", "") if img else ""

    detail_a = li.select_one("a.blue-btn[data-bookid]")
    ttv_book_id = detail_a.get("data-bookid") if detail_a else None

    return {
        "slug": slug,
        "name": unescape(name),
        "author_name": unescape(author_name),
        "author_id": author_id,
        "genre": unescape(genre),
        "status_text": unescape(status_text),
        "chapter_count": chapter_count,
        "synopsis": unescape(synopsis),
        "updated_at": updated_at,
        "cover_url": cover_url,
        "ttv_book_id": ttv_book_id,
    }


# ---------------------------------------------------------------------------
# Book detail page parser  (/doc-truyen/{slug})
# ---------------------------------------------------------------------------

def parse_book_detail(html: str, slug: str) -> dict:
    """Parse a book detail page and return metadata compatible with binslib import.

    Returns a dict matching the MTC metadata.json schema.
    """
    soup = BeautifulSoup(html, "lxml")

    # Title
    h1 = soup.select_one("div.book-info h1")
    name = h1.get_text(strip=True) if h1 else slug

    # Author
    author_a = soup.select_one("div.book-info p.tag a[href*='tac-gia']")
    author_name = author_a.get_text(strip=True) if author_a else ""
    author_id = _extract_author_id(author_a.get("href", "")) if author_a else None

    # Status
    status_span = soup.select_one("div.book-info p.tag span.blue")
    status_text = status_span.get_text(strip=True) if status_span else ""
    status = _map_status(status_text)

    # Genres
    genre_links = soup.select("div.book-info p.tag a[href*='the-loai']")
    genres = []
    for a in genre_links:
        genre_href = a.get("href", "")
        genre_slug = genre_href.rstrip("/").split("/")[-1] if genre_href else ""
        genres.append({"name": a.get_text(strip=True), "slug": genre_slug})

    # Synopsis
    intro_p = soup.select_one("div.book-info p.intro")
    if not intro_p:
        intro_p = soup.select_one("div.book-intro p")
    synopsis = intro_p.get_text(strip=True) if intro_p else ""

    # Full synopsis from the detail section
    full_intro = soup.select_one("div.book-info-detail div.book-intro p")
    if full_intro:
        synopsis = full_intro.decode_contents().replace("<br/>", "\n").replace("<br>", "\n")
        synopsis = BeautifulSoup(synopsis, "lxml").get_text(strip=True)

    # Stats
    view_count = _parse_stat(soup, "ULtwOOTH-view")
    bookmark_count = _parse_stat(soup, "ULtwOOTH-like")
    follow_count = _parse_stat(soup, "ULtwOOTH-follow")
    vote_count = _parse_stat(soup, "ULtwOOTH-nomi")

    # Rating
    rate_el = soup.select_one("cite#myrate")
    review_score = float(rate_el.get_text(strip=True)) if rate_el else 0.0

    rating_count_el = soup.select_one("span#myrating")
    review_count = _parse_int(rating_count_el.get_text(strip=True)) if rating_count_el else 0

    # Chapter count from tab label
    catalog_tab = soup.select_one("a#j-bookCatalogPage")
    chapter_count = 0
    if catalog_tab:
        m = re.search(r'(\d+)\s*chương', catalog_tab.get_text())
        if m:
            chapter_count = int(m.group(1))

    # Cover image
    cover_img = soup.select_one("div.book-img img")
    cover_url = cover_img.get("src", "") if cover_img else ""
    # Also check og:image meta tag as fallback
    if not cover_url or "default-book" in cover_url:
        og_img = soup.select_one('meta[property="og:image"]')
        if og_img:
            cover_url = og_img.get("content", "")

    # TTV internal story ID
    story_id_input = soup.select_one("input#story_id_hidden")
    ttv_story_id = story_id_input.get("value") if story_id_input else None
    if not ttv_story_id:
        meta_detail = soup.select_one('meta[name="book_detail"]')
        if meta_detail:
            ttv_story_id = meta_detail.get("content")

    # Dates from JSON-LD
    date_published = ""
    date_modified = ""
    ld_script = soup.select_one('script[type="application/ld+json"]')
    if ld_script:
        import json
        try:
            ld = json.loads(ld_script.string)
            date_published = ld.get("datePublished", "")
            date_modified = ld.get("dateModified", "")
        except (json.JSONDecodeError, TypeError):
            pass

    # Chapter URLs from the first page of the chapter list
    chapter_links = _parse_chapter_list_from_book_page(soup)

    return {
        "name": unescape(name),
        "slug": slug,
        "synopsis": unescape(synopsis),
        "status": status,
        "status_name": unescape(status_text),
        "view_count": view_count,
        "comment_count": 0,
        "bookmark_count": bookmark_count,
        "vote_count": vote_count,
        "follow_count": follow_count,
        "review_score": review_score,
        "review_count": review_count,
        "chapter_count": chapter_count,
        "word_count": 0,
        "cover_url": cover_url,
        "author": {"id": author_id, "name": unescape(author_name)},
        "genres": genres,
        "tags": [],
        "created_at": date_published,
        "updated_at": date_modified,
        "published_at": date_published,
        "ttv_story_id": ttv_story_id,
        "source": "tangthuvien",
        "_chapter_links": chapter_links,
    }


def _parse_chapter_list_from_book_page(soup: BeautifulSoup) -> list[dict]:
    """Extract chapter links from the book detail page's embedded chapter list.

    Returns list of {url, title, index} for chapters on the first page.
    The list is in ascending order (chapter 1 first).
    """
    chapters = []
    volume_wrap = soup.select_one("div.volume-wrap div.volume")
    if not volume_wrap:
        return chapters

    for li in volume_wrap.select("ul.cf li a"):
        href = li.get("href", "")
        title = li.get("title", "") or li.get_text(strip=True)
        title = unescape(title).replace("\xa0", " ")

        idx = _extract_chapter_index(href)
        chapters.append({"url": href, "title": title, "index": idx})

    # Sort by index ascending
    chapters.sort(key=lambda c: c["index"])
    return chapters


# ---------------------------------------------------------------------------
# Chapter page parser  (/doc-truyen/{slug}/chuong-{N})
# ---------------------------------------------------------------------------

def parse_chapter(html: str) -> dict | None:
    """Parse a chapter page and extract title and body text.

    Returns {title, body} or None if the page doesn't contain chapter content.
    """
    soup = BeautifulSoup(html, "lxml")

    # Chapter title from <h2>
    h2 = soup.select_one("h2")
    if not h2:
        return None
    title = h2.get_text(strip=True).replace("\xa0", " ")

    # Body text from div.box-chap elements
    box_chaps = soup.select("div.box-chap")
    if not box_chaps:
        return None

    paragraphs = []
    for box in box_chaps:
        text = box.get_text(separator="\n").strip()
        if text:
            paragraphs.append(text)

    body = "\n\n".join(paragraphs)
    if not body:
        return None

    return {
        "title": unescape(title),
        "body": body,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _extract_slug(url: str) -> str:
    """Extract book slug from a tangthuvien book URL."""
    # https://truyen.tangthuvien.vn/doc-truyen/muc-than-ky -> muc-than-ky
    path = url.rstrip("/").split("/doc-truyen/")[-1] if "/doc-truyen/" in url else ""
    # Remove query string
    path = path.split("?")[0]
    return path


def _extract_author_id(url: str) -> int | None:
    """Extract author ID from a tangthuvien author URL."""
    m = re.search(r'author=(\d+)', url)
    return int(m.group(1)) if m else None


def _extract_chapter_index(url: str) -> int:
    """Extract chapter index from a chapter URL.

    URLs look like:
        /doc-truyen/slug/chuong-5
        /doc-truyen/slug/3396871-chuong-75
        /doc-truyen/slug/chuong-0-troi-toi-dung-di-ra-ngoai
    """
    m = re.search(r'chuong-(\d+)', url)
    return int(m.group(1)) if m else 0


def _parse_stat(soup: BeautifulSoup, class_fragment: str) -> int:
    """Parse a stat value from a span with a class containing the fragment."""
    el = soup.select_one(f"span[class*='{class_fragment}']")
    if el:
        return _parse_int(el.get_text(strip=True))
    return 0


def _parse_int(text: str) -> int:
    """Parse an integer from text, ignoring non-digit characters."""
    cleaned = re.sub(r'[^\d]', '', text)
    return int(cleaned) if cleaned else 0


def _map_status(text: str) -> int:
    """Map Vietnamese status text to numeric status code."""
    text = text.lower().strip()
    if "hoàn thành" in text or "hoan thanh" in text:
        return 2
    if "tạm dừng" in text or "tam dung" in text:
        return 3
    return 1  # ongoing by default
