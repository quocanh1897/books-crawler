"""Cover image download with URL fallback and retry."""
from __future__ import annotations

import os

import httpx


async def download_cover(
    client: httpx.AsyncClient,
    book_id: int,
    poster: dict | str | None,
    covers_dir: str,
) -> str | None:
    """Download cover image, trying poster URLs in size order.

    Returns '/covers/{book_id}.jpg' on success, None on failure.
    Skips if cover already exists on disk.
    """
    dest = os.path.join(covers_dir, f"{book_id}.jpg")
    if os.path.exists(dest):
        return f"/covers/{book_id}.jpg"

    if poster is None:
        return None

    # Handle poster as dict with size keys
    if isinstance(poster, dict):
        for key in ["default", "600", "300", "150"]:
            url = poster.get(key)
            if not url:
                continue
            try:
                r = await client.get(url, follow_redirects=True, timeout=30)
                if r.status_code == 200 and len(r.content) > 100:
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    with open(dest, "wb") as f:
                        f.write(r.content)
                    return f"/covers/{book_id}.jpg"
            except Exception:
                continue

    # Handle poster as plain string URL
    if isinstance(poster, str):
        try:
            r = await client.get(poster, follow_redirects=True, timeout=30)
            if r.status_code == 200 and len(r.content) > 100:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as f:
                    f.write(r.content)
                return f"/covers/{book_id}.jpg"
        except Exception:
            pass

    return None
