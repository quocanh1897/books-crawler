"""Configuration for crawler-tangthuvien."""

import os

BASE_URL = "https://truyen.tangthuvien.vn"

HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
}

REQUEST_DELAY = 1.5  # seconds between requests
MAX_RETRIES = 3

# Tangthuvien book IDs start at 10M to avoid collision with MTC IDs (< 1M)
ID_OFFSET = 10_000_000

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")

# Path to MTC crawler output (kept for reference / fallback)
MTC_OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "crawler", "output")

# Source of truth for deduplication: binslib SQLite database
BINSLIB_DB_PATH = os.path.join(
    os.path.dirname(__file__), "..", "binslib", "data", "binslib.db"
)

REGISTRY_PATH = os.path.join(os.path.dirname(__file__), "book_registry.json")
