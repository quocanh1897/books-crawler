"""
Test decryption based on blutter reverse-engineering of _getChapterDetailsEncrypt.

Discovered algorithm from Dart AOT assembly analysis:
1. content string from API has key bytes INJECTED at positions [start:end]
2. key_chars = content[start:end]
3. clean_b64 = content.replace(key_chars, "")
4. envelope = json.loads(utf8_decode(base64_decode(clean_b64)))
5. key_bytes = bytes(ord(c) for c in key_chars)  (Dart's codeUnits → Uint8List)
6. iv_bytes = base64_decode(envelope["iv"])
7. ciphertext = base64_decode(envelope["value"])
8. plaintext = aes_cbc_decrypt(ciphertext, key_bytes, iv_bytes)

The ARM64 instructions show: content.substring(17, 66)
But the end value (66) may be Smi-encoded (66>>1 = 33), giving substring(17, 33) = 16 chars.
We try multiple slice ranges to determine the correct interpretation.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import httpx
from config import BASE_URL, HEADERS
from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad

CHAPTER_ID = 10340503
KNOWN_PLAINTEXT_PREFIX = "Chương 1: Tiêu Phàm trọng sinh"


def fetch_raw_chapter(chapter_id: int) -> dict:
    """Fetch chapter data and return the full API response data."""
    with httpx.Client(headers=HEADERS, timeout=30) as client:
        r = client.get(f"{BASE_URL}/api/chapters/{chapter_id}")
        r.raise_for_status()
        data = r.json()
        if not data.get("success"):
            raise RuntimeError(f"API error: {data}")
        return data["data"]


def try_decrypt(content: str, start: int, end: int, label: str) -> str | None:
    """Try the blutter-discovered decryption with given slice parameters.

    Returns decrypted plaintext on success, None on failure.
    """
    if end > len(content):
        print(f"  [{label}] content too short ({len(content)} chars, need {end})")
        return None

    key_chars = content[start:end]
    key_len = end - start
    clean_b64 = content.replace(key_chars, "", 1)

    # Step 1: decode the clean base64 → JSON envelope
    try:
        padding = (4 - len(clean_b64) % 4) % 4
        raw_bytes = base64.b64decode(clean_b64 + "=" * padding)
        envelope_str = raw_bytes.decode("utf-8")
        envelope = json.loads(envelope_str)
    except Exception as e:
        print(f"  [{label}] envelope parse failed: {e}")
        return None

    if not all(k in envelope for k in ("iv", "value", "mac")):
        print(f"  [{label}] envelope missing fields, keys: {list(envelope.keys())}")
        return None

    print(
        f"  [{label}] envelope parsed OK: iv={len(envelope['iv'])}ch, "
        f"value={len(envelope['value'])}ch, mac={len(envelope['mac'])}ch"
    )

    # Step 2: key bytes = code units of the extracted substring
    key_bytes = bytes(ord(c) for c in key_chars)

    # Step 3: decode IV from the clean envelope
    try:
        iv_bytes = base64.b64decode(envelope["iv"])
    except Exception as e:
        print(f"  [{label}] IV decode failed: {e}")
        return None

    if len(iv_bytes) != 16:
        print(f"  [{label}] IV is {len(iv_bytes)} bytes, expected 16")
        return None

    # Step 4: decode ciphertext
    try:
        ciphertext = base64.b64decode(envelope["value"])
    except Exception as e:
        print(f"  [{label}] ciphertext decode failed: {e}")
        return None

    if len(ciphertext) % 16 != 0:
        print(f"  [{label}] ciphertext not 16-byte aligned: {len(ciphertext)}")
        return None

    # Step 5: try AES-CBC decryption with various key derivations
    key_variants = [
        ("raw", key_bytes),
    ]

    if key_len not in (16, 24, 32):
        key_variants.extend(
            [
                ("truncate-16", key_bytes[:16]),
                ("truncate-24", key_bytes[:24]) if key_len >= 24 else None,
                ("truncate-32", key_bytes[:32]) if key_len >= 32 else None,
                ("sha256", hashlib.sha256(key_bytes).digest()),
                ("md5", hashlib.md5(key_bytes).digest()),
            ]
        )
        key_variants = [kv for kv in key_variants if kv is not None]

    for kname, kbytes in key_variants:
        if len(kbytes) not in (16, 24, 32):
            continue
        try:
            cipher = AES.new(kbytes, AES.MODE_CBC, iv_bytes)
            decrypted = unpad(cipher.decrypt(ciphertext), AES.block_size)
            plaintext = decrypted.decode("utf-8").strip()
            if plaintext.startswith(KNOWN_PLAINTEXT_PREFIX):
                print(
                    f"  [{label}] key={kname} ({len(kbytes)}B) -> DECRYPTION SUCCESS!"
                )
                return plaintext
            else:
                preview = plaintext[:80] if plaintext else "(empty)"
                print(
                    f"  [{label}] key={kname} ({len(kbytes)}B) -> decrypted but wrong prefix: {preview!r}"
                )
        except Exception as e:
            err = str(e)[:60]
            print(f"  [{label}] key={kname} ({len(kbytes)}B) -> {err}")

    return None


def main():
    print(f"Fetching chapter {CHAPTER_ID}...")
    chapter = fetch_raw_chapter(CHAPTER_ID)
    content = chapter.get("content", "")
    print(f"Content length: {len(content)} chars")
    print(f"Content prefix (first 80): {content[:80]!r}")
    print(f"Content[17:33]: {content[17:33]!r}")
    print(f"Content[17:49]: {content[17:49]!r}")
    print(f"Content[17:66]: {content[17:66]!r}")
    print()

    # Try all plausible slice ranges based on the ARM64 assembly analysis
    slices = [
        (17, 33, "sub(17,33) 16ch AES-128 [end=66>>1 Smi]"),
        (17, 49, "sub(17,49) 32ch AES-256"),
        (17, 66, "sub(17,66) 49ch [raw ARM values]"),
        (8, 24, "sub(8,24) 16ch [start=17>>1 Smi, end=48>>1]"),
        (8, 40, "sub(8,40) 32ch [both Smi shifted]"),
    ]

    for start, end, label in slices:
        print(f"\n--- Trying {label} ---")
        result = try_decrypt(content, start, end, label)
        if result:
            print(f"\n{'=' * 60}")
            print(f"SUCCESS with slice [{start}:{end}]")
            print(
                f"Key chars (as hex): {bytes(ord(c) for c in content[start:end]).hex()}"
            )
            print(f"Plaintext preview: {result[:200]}")
            print(f"{'=' * 60}")
            return True

    print("\n--- None of the standard slices worked. ---")
    print("Trying exhaustive search for 16-byte key slices near position 17...")

    for start in range(10, 25):
        for key_len in (16, 24, 32):
            end = start + key_len
            label = f"scan({start},{end})"
            result = try_decrypt(content, start, end, label)
            if result:
                print(f"\n{'=' * 60}")
                print(f"SUCCESS with slice [{start}:{end}]")
                print(
                    f"Key chars (as hex): {bytes(ord(c) for c in content[start:end]).hex()}"
                )
                print(f"Plaintext preview: {result[:200]}")
                print(f"{'=' * 60}")
                return True

    print("\nAll attempts failed.")
    return False


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
