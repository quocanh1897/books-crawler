"""Source registry and factory.

Usage::

    from src.sources import create_source

    source = create_source("mtc", max_concurrent=60)
    async with source:
        meta = await source.fetch_book_metadata(entry)
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import BookSource

# Lazy imports to avoid pulling in heavy dependencies (httpx, bs4, …)
# when only one source is needed.

_REGISTRY: dict[str, str] = {
    "mtc": "src.sources.mtc",
    "ttv": "src.sources.ttv",
}

_CLASS_NAMES: dict[str, str] = {
    "mtc": "MTCSource",
    "ttv": "TTVSource",
}

VALID_SOURCES = tuple(_REGISTRY.keys())


def create_source(name: str, **kwargs: object) -> BookSource:
    """Instantiate a :class:`BookSource` by short name.

    Parameters
    ----------
    name:
        One of ``"mtc"`` or ``"ttv"``.
    **kwargs:
        Forwarded to the source constructor (e.g. ``max_concurrent``,
        ``request_delay``).

    Raises
    ------
    ValueError
        If *name* is not a registered source.
    """
    if name not in _REGISTRY:
        valid = ", ".join(sorted(VALID_SOURCES))
        raise ValueError(f"Unknown source {name!r}. Valid sources: {valid}")

    import importlib

    module = importlib.import_module(_REGISTRY[name])
    cls = getattr(module, _CLASS_NAMES[name])
    return cls(**kwargs)
