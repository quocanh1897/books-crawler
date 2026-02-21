BASE_URL = "https://android.lonoapp.net"
BEARER_TOKEN = "7050589|YnIYK76km8VCVjbiDFORxh1e8fbYPkXocCGpOefI"

REQUEST_DELAY = 1.5  # seconds between requests
MAX_RETRIES = 3
OUTPUT_DIR = "output"

HEADERS = {
    "authorization": f"Bearer {BEARER_TOKEN}",
    "x-app": "app.android",
    "user-agent": "Dart/3.5 (dart:io)",
    "content-type": "application/json",
}
