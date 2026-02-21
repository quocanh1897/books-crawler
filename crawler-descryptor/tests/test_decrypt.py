#!/usr/bin/env python3
"""
Test decryption against known encrypted/decrypted sample pairs.

Requires:
1. Samples collected via collect_samples.py
2. The correct encryption key (set via DECRYPT_KEY env var or hardcode below)

Usage:
    DECRYPT_KEY=<hex> python3 -m pytest tests/test_decrypt.py -v
"""
from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

SAMPLES_DIR = os.path.join(os.path.dirname(__file__), "samples")


def get_sample_pairs() -> list[tuple[str, str]]:
    """Find all encrypted/decrypted pairs in tests/samples/."""
    pairs = []
    if not os.path.isdir(SAMPLES_DIR):
        return pairs
    for f in sorted(os.listdir(SAMPLES_DIR)):
        if f.endswith("_encrypted.json"):
            dec_file = f.replace("_encrypted.json", "_decrypted.txt")
            if os.path.exists(os.path.join(SAMPLES_DIR, dec_file)):
                pairs.append((
                    os.path.join(SAMPLES_DIR, f),
                    os.path.join(SAMPLES_DIR, dec_file),
                ))
    return pairs


class TestDecryption(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        key_hex = os.environ.get("DECRYPT_KEY")
        if not key_hex:
            raise unittest.SkipTest(
                "DECRYPT_KEY env var not set. Extract the key via Frida first."
            )
        from src.decrypt import set_key_hex
        set_key_hex(key_hex)

    def test_samples_exist(self):
        pairs = get_sample_pairs()
        self.assertGreater(len(pairs), 0,
                           "No sample pairs found. Run collect_samples.py first.")

    def test_decrypt_matches_plaintext(self):
        from src.decrypt import decrypt_content
        pairs = get_sample_pairs()
        if not pairs:
            self.skipTest("No sample pairs")

        for enc_path, dec_path in pairs:
            with self.subTest(sample=os.path.basename(enc_path)):
                with open(enc_path) as f:
                    sample = json.load(f)
                with open(dec_path) as f:
                    expected = f.read()

                result = decrypt_content(sample["content_encrypted"])
                self.assertEqual(result.strip(), expected.strip(),
                                 f"Decryption mismatch for {os.path.basename(enc_path)}")

    def test_bruteforce_strategies(self):
        """Try all IV strategies and report which ones produce valid output."""
        from src.decrypt import decrypt_content_bruteforce
        pairs = get_sample_pairs()
        if not pairs:
            self.skipTest("No sample pairs")

        enc_path, dec_path = pairs[0]
        with open(enc_path) as f:
            sample = json.load(f)

        results = decrypt_content_bruteforce(sample["content_encrypted"])
        working = [name for name, text in results.items()
                   if not text.startswith("Error:")]
        print(f"\nWorking IV strategies: {working}")
        print(f"All results: {json.dumps(results, indent=2, ensure_ascii=False)}")


if __name__ == "__main__":
    unittest.main()
