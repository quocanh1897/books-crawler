"""
IV de-obfuscation for the mobile API's Laravel encryption envelope.

The IV field is 36 bytes with non-base64 bytes injected around positions 6-17.
Standard Laravel would have a 24-char base64 string (= 16 bytes).

This module implements multiple IV extraction strategies. The correct one
will be determined after Frida captures the actual IV bytes at runtime.

Once the correct method is known, set DEFAULT_STRATEGY to it.
"""
from __future__ import annotations

import base64
import re
import string

B64_CHARS = set(string.ascii_letters + string.digits + "+/=")


def strategy_strip_nonb64(iv_raw: str) -> bytes:
    """Strip all non-base64 characters, then decode."""
    cleaned = "".join(c for c in iv_raw if c in B64_CHARS)
    # Pad to multiple of 4 if needed
    pad = (4 - len(cleaned) % 4) % 4
    cleaned += "=" * pad
    return base64.b64decode(cleaned)


def strategy_slice_6_17(iv_raw: bytes) -> bytes:
    """Remove bytes at positions 6-17 (inclusive), decode the rest as base64.

    This always gives 24 base64 chars = 16 bytes, but decryption failed
    in previous testing. Kept as a reference.
    """
    cleaned = iv_raw[:6] + iv_raw[18:]
    return base64.b64decode(cleaned)


def strategy_raw_bytes(iv_raw: str) -> bytes:
    """Treat the raw IV field bytes directly (no base64 decoding).

    If the IV is actually raw binary stuffed into the JSON string,
    take the first 16 bytes or a specific 16-byte slice.
    """
    raw = iv_raw.encode("latin-1")
    return raw[:16]


def strategy_raw_b64_suffix(iv_raw: str) -> bytes:
    """Take only the base64 portion after the obfuscated prefix.

    If the format is: 6 clean b64 chars + N garbage + remaining b64 + "=="
    """
    # Find where the garbage ends (first valid b64 char after pos 6)
    for i in range(6, len(iv_raw)):
        if iv_raw[i] in B64_CHARS:
            suffix_start = i
            break
    else:
        return b""
    suffix = iv_raw[suffix_start:]
    return base64.b64decode(suffix)


# Placeholder: will be set to the correct function after Frida analysis
DEFAULT_STRATEGY = None

ALL_STRATEGIES = {
    "strip_nonb64": strategy_strip_nonb64,
    "slice_6_17": strategy_slice_6_17,
    "raw_bytes": strategy_raw_bytes,
    "raw_b64_suffix": strategy_raw_b64_suffix,
}


def extract_iv(iv_field: str, strategy: str | None = None) -> bytes:
    """Extract the 16-byte AES IV from the obfuscated IV field.

    Args:
        iv_field: The raw IV string from the Laravel envelope.
        strategy: Strategy name. If None, uses DEFAULT_STRATEGY or raises.

    Returns:
        16-byte IV for AES-CBC.

    Raises:
        ValueError: If no strategy is set or extraction produces wrong length.
    """
    if strategy:
        fn = ALL_STRATEGIES[strategy]
    elif DEFAULT_STRATEGY:
        fn = DEFAULT_STRATEGY
    else:
        raise ValueError(
            "No IV extraction strategy set. Run Frida hooks first to determine "
            "the correct method, then set DEFAULT_STRATEGY in iv_extract.py."
        )

    iv = fn(iv_field)
    if len(iv) != 16:
        raise ValueError(
            f"IV extraction produced {len(iv)} bytes, expected 16. "
            f"Strategy may be wrong."
        )
    return iv


def try_all_strategies(iv_field: str) -> dict[str, bytes | str]:
    """Try all strategies and return results (for debugging/analysis)."""
    results = {}
    for name, fn in ALL_STRATEGIES.items():
        try:
            iv = fn(iv_field)
            results[name] = {
                "bytes": iv,
                "hex": iv.hex(),
                "length": len(iv),
                "valid": len(iv) == 16,
            }
        except Exception as e:
            results[name] = {"error": str(e)}
    return results
