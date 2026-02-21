"""
Decrypt chapter content from the mobile API.

The API returns content as a base64 string with an embedded AES-128 key:
  - Positions [17:33] contain 16 characters that ARE the AES key (byte values)
  - Removing those 16 chars yields clean base64 that decodes to a JSON envelope:
    {"iv": "<base64>", "value": "<base64>", "mac": "<hex>"}
  - iv: standard base64-encoded 16-byte AES IV
  - value: base64-encoded AES-128-CBC ciphertext (PKCS7 padded)
  - mac: HMAC-SHA256 hex digest for integrity

Algorithm reverse-engineered from Dart AOT binary (blutter analysis of
_getChapterDetailsEncrypt in novelfever/utils/api_client.dart).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json

from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad

KEY_START = 17
KEY_END = 33
KEY_LEN = KEY_END - KEY_START  # 16 bytes = AES-128


class DecryptionError(Exception):
    pass


def extract_key_and_envelope(content: str) -> tuple[bytes, dict]:
    """Extract the AES key and parse the JSON envelope from raw API content.

    The content string has 16 key characters injected at positions [17:33].
    Removing them produces clean base64 that decodes to the encryption envelope.

    Returns:
        (key_bytes, envelope_dict) where envelope has 'iv', 'value', 'mac'.
    """
    if len(content) < KEY_END:
        raise DecryptionError(
            f"Content too short ({len(content)} chars, need at least {KEY_END})"
        )

    key_chars = content[KEY_START:KEY_END]
    key_bytes = bytes(ord(c) for c in key_chars)

    clean_b64 = content.replace(key_chars, "", 1)

    padding = (4 - len(clean_b64) % 4) % 4
    raw_bytes = base64.b64decode(clean_b64 + "=" * padding)
    envelope_str = raw_bytes.decode("utf-8")
    envelope = json.loads(envelope_str)

    for field in ("iv", "value", "mac"):
        if field not in envelope:
            raise DecryptionError(f"Missing '{field}' in envelope")

    return key_bytes, envelope


def verify_mac(envelope: dict, key: bytes) -> bool:
    """Verify the HMAC-SHA256 MAC (Laravel convention).

    Laravel computes: HMAC-SHA256(iv_b64 + value_b64, key)
    """
    mac_input = (envelope["iv"] + envelope["value"]).encode("utf-8")
    expected = hmac.new(key, mac_input, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, envelope["mac"])


def decrypt_content(content: str, verify: bool = False) -> str:
    """Decrypt a chapter's content field from the API.

    Args:
        content: The raw content string from the API response.
        verify: Whether to verify the MAC before decrypting.

    Returns:
        Decrypted plaintext string (trimmed).

    Raises:
        DecryptionError: If extraction, parsing, or decryption fails.
    """
    try:
        key, envelope = extract_key_and_envelope(content)
    except DecryptionError:
        raise
    except Exception as e:
        raise DecryptionError(f"Failed to extract key/envelope: {e}")

    if verify and not verify_mac(envelope, key):
        raise DecryptionError("MAC verification failed")

    try:
        iv = base64.b64decode(envelope["iv"])
        ciphertext = base64.b64decode(envelope["value"])
    except Exception as e:
        raise DecryptionError(f"Failed to decode IV/ciphertext: {e}")

    if len(iv) != 16:
        raise DecryptionError(f"IV is {len(iv)} bytes, expected 16")
    if len(ciphertext) % 16 != 0:
        raise DecryptionError(f"Ciphertext not 16-byte aligned: {len(ciphertext)}")

    try:
        cipher = AES.new(key, AES.MODE_CBC, iv)
        plaintext = unpad(cipher.decrypt(ciphertext), AES.block_size)
        return plaintext.decode("utf-8").strip()
    except ValueError as e:
        raise DecryptionError(f"AES decryption failed: {e}")
