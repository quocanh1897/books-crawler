"""
Tests for decrypt_chapter() — verifies that chapter titles come from the
API's ``name`` field, NOT from the first line of the decrypted body text.

Bug description:
  The old code used ``lines[0].strip()`` (the first line of the decrypted
  plaintext) as the chapter title.  For a book like "Quỷ Bí Chi Chủ",
  chapter 1's API name is "Chương 1: ửng đỏ", but the old code consumed
  that title line, leaving the body starting with "đau…".  Then when
  import.ts re-extracted titles from the stored body, it got "đau" as the
  title — wrong and duplicated in the reader.

  Actual API response for chapter 1 of "Quỷ Bí Chi Chủ" (book 101380):
    chapter["name"]  = "Chương 1: ửng đỏ"
    decrypted content line 0 = "Chương 1: ửng đỏ"   ← title embedded
    decrypted content line 2 = "đau"                 ← actual body start

  The API ``name`` field always includes the "Chương X:" prefix.  The
  decrypted body always starts with that same title as line 0.

Run:
    cd book-ingest
    python -m pytest test_chapter_title.py -v
  or:
    python test_chapter_title.py
"""

from __future__ import annotations

import sys
import unittest
from unittest.mock import patch

# Ensure the package is importable
sys.path.insert(0, ".")

from src.api import decrypt_chapter
from src.decrypt import DecryptionError

# ---------------------------------------------------------------------------
# All tests mock decrypt_content so we don't need real AES ciphertext.
# ---------------------------------------------------------------------------

MOCK_DECRYPT = "src.api.decrypt_content"

# Realistic decrypted content for "Quỷ Bí Chi Chủ" chapter 1:
# Line 0 = title (embedded by the API), then blank line, then body.
REALISTIC_PLAINTEXT_CH1 = (
    "Chương 1: ửng đỏ\n"
    "\n"
    "đau\n"
    "\n"
    "đau quá!\n"
    "\n"
    "Đầu đau quá!\n"
    "\n"
    "Kỳ quái tràn đầy nói nhỏ mộng cảnh cấp tốc nát vụn, "
    "đang ngủ say Chu Minh Thụy chỉ cảm thấy đầu co rút đau đớn dị thường"
)

# Realistic decrypted content for "Võ Đạo Tông Sư" chapter 1:
REALISTIC_PLAINTEXT_VODAO = (
    "Chương 1: Thiếu niên chí khí không nói sầu\n"
    "\n"
    "Nắng gắt cuối thu uy phong lẫm lẫm, vẫn dò xét nhân gian, "
    "ba giờ chiều ánh mặt trời trắng lóa mà khốc liệt\n"
    "\n"
    "Tràng quán cửa chính bên trên có mấy cái màu đen"
)


def _make_chapter(
    *,
    index: int = 1,
    name: str = "Chương 1: ửng đỏ",
    slug: str = "chuong-1-ung-do",
    content: str = "FAKE_ENCRYPTED",
) -> dict:
    """Build a minimal chapter dict resembling the API response."""
    return {
        "id": 9000 + index,
        "index": index,
        "name": name,
        "slug": slug,
        "content": content,
    }


class TestDecryptChapterTitle(unittest.TestCase):
    """Title must come from chapter['name'], never from body text."""

    # -- core: title from API name, body deduplication ---------------------

    @patch(MOCK_DECRYPT, return_value=REALISTIC_PLAINTEXT_CH1)
    def test_title_is_api_name_for_quy_bi_chi_chu(self, _mock):
        """Realistic: API name = 'Chương 1: ửng đỏ', body starts with 'đau'."""
        ch = _make_chapter(name="Chương 1: ửng đỏ")
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 1: ửng đỏ")
        # The embedded title line must be stripped from the body
        self.assertFalse(body.startswith("Chương 1: ửng đỏ"))
        # Body must start with the actual story content
        self.assertTrue(body.startswith("đau"))

    @patch(MOCK_DECRYPT, return_value=REALISTIC_PLAINTEXT_VODAO)
    def test_title_is_api_name_for_vo_dao(self, _mock):
        """Realistic: API name includes 'Chương 1:' prefix."""
        ch = _make_chapter(
            name="Chương 1: Thiếu niên chí khí không nói sầu",
            slug="chuong-1-thieu-nien-chi-khi-khong-noi-sau",
        )
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 1: Thiếu niên chí khí không nói sầu")
        self.assertFalse(body.startswith("Chương 1:"))
        self.assertTrue(body.startswith("Nắng gắt cuối thu"))

    @patch(MOCK_DECRYPT, return_value=REALISTIC_PLAINTEXT_CH1)
    def test_title_never_uses_first_body_line(self, _mock):
        """Title must NOT be 'đau' (the first actual body line after dedup)."""
        ch = _make_chapter(name="Chương 1: ửng đỏ")
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertNotEqual(title, "đau")
        self.assertNotEqual(title, "đau đớn quá đi mất")

    @patch(MOCK_DECRYPT, return_value=REALISTIC_PLAINTEXT_CH1)
    def test_no_duplication_between_title_and_body(self, _mock):
        """The title text must not appear as the first line of the body."""
        ch = _make_chapter(name="Chương 1: ửng đỏ")
        title, slug, body, wc = decrypt_chapter(ch)

        first_body_line = ""
        for line in body.split("\n"):
            if line.strip():
                first_body_line = line.strip()
                break

        # Title is "Chương 1: ửng đỏ", first body line is "đau" — different ✓
        self.assertNotEqual(title, first_body_line)

    # -- deduplication: embedded title line stripped from body ---------------

    @patch(
        MOCK_DECRYPT,
        return_value="Chương 5: Nghi thức\n\nNội dung chương bắt đầu ở đây",
    )
    def test_embedded_title_stripped_from_body(self, _mock):
        """The decrypted content always starts with the title — must be stripped."""
        ch = _make_chapter(name="Chương 5: Nghi thức", index=5)
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 5: Nghi thức")
        self.assertFalse(body.startswith("Chương 5:"))
        self.assertTrue(body.startswith("Nội dung chương bắt đầu ở đây"))

    @patch(MOCK_DECRYPT, return_value="\n\nChương 3: Melissa\n\nNội dung tiếp theo")
    def test_embedded_title_stripped_after_leading_blanks(self, _mock):
        """Leading blank lines are skipped before checking for title dup."""
        ch = _make_chapter(name="Chương 3: Melissa", index=3)
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 3: Melissa")
        self.assertFalse(body.startswith("Chương 3:"))
        self.assertTrue(body.startswith("Nội dung tiếp theo"))

    @patch(
        MOCK_DECRYPT,
        return_value="Chương 1: ửng đỏ\n\nChương 1: ửng đỏ xuất hiện trong văn bản",
    )
    def test_only_leading_title_stripped_not_later_occurrences(self, _mock):
        """Only the leading embedded title is removed, not in-text occurrences."""
        ch = _make_chapter(name="Chương 1: ửng đỏ")
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 1: ửng đỏ")
        # The second occurrence is genuine content — must be kept
        self.assertIn("Chương 1: ửng đỏ xuất hiện trong văn bản", body)

    @patch(MOCK_DECRYPT, return_value="Nội dung không bắt đầu bằng title\n\nDòng hai")
    def test_body_preserved_when_no_embedded_title(self, _mock):
        """If body doesn't start with the title, all lines are kept."""
        ch = _make_chapter(name="Chương 1: Tên khác", index=1)
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 1: Tên khác")
        self.assertEqual(body, "Nội dung không bắt đầu bằng title\n\nDòng hai")

    # -- API name format: always includes "Chương X:" prefix ----------------

    @patch(MOCK_DECRYPT, return_value="Chương 01: Loạn thế\n\nNội dung chương")
    def test_api_name_with_zero_padded_index(self, _mock):
        """Some books use zero-padded chapter numbers like 'Chương 01:'."""
        ch = _make_chapter(name="Chương 01: Loạn thế", index=1)
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 01: Loạn thế")
        self.assertTrue(body.startswith("Nội dung chương"))

    @patch(MOCK_DECRYPT, return_value="Chương 1412: Kết thúc\n\nĐoạn cuối cùng")
    def test_high_chapter_number(self, _mock):
        """Chapter numbers can go into the thousands."""
        ch = _make_chapter(name="Chương 1412: Kết thúc", index=1412)
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 1412: Kết thúc")
        self.assertTrue(body.startswith("Đoạn cuối cùng"))

    # -- fallback when API name is missing ---------------------------------

    @patch(MOCK_DECRYPT, return_value="Nội dung body ở đây")
    def test_fallback_title_when_name_empty(self, _mock):
        """If the API provides an empty name, fall back to 'Chương {index}'."""
        ch = _make_chapter(name="", index=42)
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 42")

    @patch(MOCK_DECRYPT, return_value="Nội dung body ở đây")
    def test_fallback_title_when_name_key_absent(self, _mock):
        """If the chapter dict has no 'name' key at all."""
        ch = {"index": 7, "slug": "chapter-7", "content": "FAKE"}
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 7")

    @patch(MOCK_DECRYPT, return_value="Nội dung body ở đây")
    def test_fallback_title_when_name_is_whitespace(self, _mock):
        """A name consisting only of whitespace should trigger fallback."""
        ch = _make_chapter(name="   ", index=3)
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 3")

    # -- body integrity & edge cases ----------------------------------------

    @patch(MOCK_DECRYPT, return_value="Chương 1: Tên\nMột dòng duy nhất")
    def test_body_after_title_stripped(self, _mock):
        """Body is everything after the embedded title line."""
        ch = _make_chapter(name="Chương 1: Tên")
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(body, "Một dòng duy nhất")

    @patch(MOCK_DECRYPT, return_value="Chương 1: Tên chương")
    def test_body_empty_when_content_is_only_title(self, _mock):
        """Edge case: decrypted content is exactly the title — body becomes empty."""
        ch = _make_chapter(name="Chương 1: Tên chương")
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 1: Tên chương")
        self.assertEqual(body, "")
        self.assertEqual(wc, 0)

    @patch(MOCK_DECRYPT, return_value="")
    def test_empty_decrypted_content(self, _mock):
        """Empty plaintext after decryption."""
        ch = _make_chapter(name="Chương 1: Trống")
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 1: Trống")
        self.assertEqual(body, "")
        self.assertEqual(wc, 0)

    # -- word count --------------------------------------------------------

    @patch(MOCK_DECRYPT, return_value="Chương 1: Đếm\n\nMột hai ba bốn năm")
    def test_word_count_excludes_title_line(self, _mock):
        """Word count is computed from body only (title line stripped)."""
        ch = _make_chapter(name="Chương 1: Đếm")
        title, slug, body, wc = decrypt_chapter(ch)

        # Body = "Một hai ba bốn năm" → 5 words
        self.assertEqual(wc, 5)

    @patch(MOCK_DECRYPT, return_value=REALISTIC_PLAINTEXT_CH1)
    def test_word_count_realistic(self, _mock):
        """Word count for realistic content."""
        ch = _make_chapter(name="Chương 1: ửng đỏ")
        title, slug, body, wc = decrypt_chapter(ch)

        # Body starts with "đau" (after title stripped), count all words
        self.assertGreater(wc, 10)

    # -- slug passthrough --------------------------------------------------

    @patch(MOCK_DECRYPT, return_value="Chương 1: Test\n\nbody")
    def test_slug_from_api(self, _mock):
        ch = _make_chapter(slug="chuong-1-ung-do")
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(slug, "chuong-1-ung-do")

    @patch(MOCK_DECRYPT, return_value="body")
    def test_slug_fallback(self, _mock):
        ch = {"index": 5, "content": "FAKE"}
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(slug, "chapter-5")

    # -- error cases -------------------------------------------------------

    def test_empty_content_raises(self):
        ch = _make_chapter()
        ch["content"] = ""
        with self.assertRaises(DecryptionError):
            decrypt_chapter(ch)

    def test_missing_content_raises(self):
        ch = {"index": 1, "name": "x"}
        with self.assertRaises(DecryptionError):
            decrypt_chapter(ch)


class TestDecryptChapterOldBugRegression(unittest.TestCase):
    """
    Regression tests that document what the OLD (buggy) code produced
    and verify that the FIXED code does NOT reproduce those bugs.

    Old code flow:
      1. title = lines[0].strip()          → consumed the embedded title
      2. body  = "\n".join(lines[1:])       → body lost the title, started at real content
      3. import.ts later re-read body from bundle → first non-empty line "đau" → title = "đau"
    """

    @patch(MOCK_DECRYPT, return_value=REALISTIC_PLAINTEXT_CH1)
    def test_old_bug_would_have_produced_correct_title_initially(self, _mock):
        """
        The old decrypt_chapter actually got 'Chương 1: ửng đỏ' from line 0.
        The real bug was import.ts re-extracting from the stored body.
        Our fix ensures the API name is used, which is the same correct value.
        """
        ch = _make_chapter(name="Chương 1: ửng đỏ")
        title, slug, body, wc = decrypt_chapter(ch)

        # New code: title from API name
        self.assertEqual(title, "Chương 1: ửng đỏ")

    @patch(MOCK_DECRYPT, return_value=REALISTIC_PLAINTEXT_CH1)
    def test_body_does_not_start_with_title(self, _mock):
        """
        Both old and new code strip the title line from the body.
        The body must start with 'đau' (the actual story content),
        NOT with 'Chương 1: ửng đỏ'.
        """
        ch = _make_chapter(name="Chương 1: ửng đỏ")
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertTrue(body.startswith("đau"))
        self.assertNotIn("Chương 1: ửng đỏ\n", body.split("\n")[0])

    @patch(MOCK_DECRYPT, return_value=REALISTIC_PLAINTEXT_CH1)
    def test_body_content_preserved_completely(self, _mock):
        """All actual story content after the title is preserved."""
        ch = _make_chapter(name="Chương 1: ửng đỏ")
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertIn("đau quá!", body)
        self.assertIn("Đầu đau quá!", body)
        self.assertIn("Chu Minh Thụy", body)

    @patch(MOCK_DECRYPT, return_value=REALISTIC_PLAINTEXT_CH1)
    def test_import_ts_would_have_gotten_wrong_title_from_body(self, _mock):
        """
        Demonstrate: if someone extracts the title from the BODY
        (as import.ts did), they get the wrong answer.
        This is why we must use the API name.
        """
        ch = _make_chapter(name="Chương 1: ửng đỏ")
        title, slug, body, wc = decrypt_chapter(ch)

        # The first non-empty line of the body
        first_body_line = ""
        for line in body.split("\n"):
            if line.strip():
                first_body_line = line.strip()
                break

        # This is "đau" — NOT the correct title
        self.assertEqual(first_body_line, "đau")
        # The actual title is different
        self.assertNotEqual(title, first_body_line)
        self.assertEqual(title, "Chương 1: ửng đỏ")

    @patch(MOCK_DECRYPT, return_value=REALISTIC_PLAINTEXT_VODAO)
    def test_vo_dao_tong_su_no_double_chuong_prefix(self, _mock):
        """
        For 'Võ Đạo Tông Sư', the API name is 'Chương 1: Thiếu niên…'.
        The title must NOT be 'Chương 1: Chương 1: Thiếu niên…' (doubled).
        """
        ch = _make_chapter(
            name="Chương 1: Thiếu niên chí khí không nói sầu",
            index=1,
        )
        title, slug, body, wc = decrypt_chapter(ch)

        self.assertEqual(title, "Chương 1: Thiếu niên chí khí không nói sầu")
        # Must not contain doubled "Chương" prefix
        self.assertFalse(title.startswith("Chương 1: Chương"))


# ---------------------------------------------------------------------------
# CLI runner
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Support both `python test_chapter_title.py` and pytest
    result = unittest.main(exit=False, verbosity=2)
    sys.exit(0 if result.result.wasSuccessful() else 1)
