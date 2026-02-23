"""
API configuration for crawler-descryptor.

These constants were previously imported from the (now removed) crawler/config.py.
All crawler-descryptor scripts import from here.

To override the bearer token without editing this file, set the
environment variable MTC_BEARER_TOKEN.
"""

import os

BASE_URL = "https://android.lonoapp.net"

BEARER_TOKEN = os.environ.get(
    "MTC_BEARER_TOKEN",
    "7045826|W0GmBOqfeWO0wWZUD7QpikPjvMsP1tq7Ayjq48pX",
)

HEADERS = {
    "authorization": f"Bearer {BEARER_TOKEN}",
    "x-app": "app.android",
    "user-agent": "Dart/3.5 (dart:io)",
    "content-type": "application/json",
}

REQUEST_DELAY = 0.3
MAX_RETRIES = 3
