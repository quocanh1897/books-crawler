/**
 * Test: FTS5 search with Vietnamese diacritics
 *
 * Verifies that `unicode61 remove_diacritics 0` preserves Vietnamese tonal
 * marks so that searching for e.g. "Quỷ Bí Chi Chủ" returns the correct
 * book instead of thousands of irrelevant matches whose base syllables
 * (quy, bi, chi, chu) happen to collide after diacritic stripping.
 *
 * Run:  npx tsx test/test-search-fts.ts
 */

import Database from "better-sqlite3";

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

/** Build an FTS query the same way the search page does. */
function buildFtsQuery(q: string): string {
  return q
    .replace(/[\u201C\u201D\u2018\u2019"'()*^:]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`)
    .join(" ");
}

// ── sample data ──────────────────────────────────────────────────────────────

const BOOKS = [
  { id: 1, name: "Quỷ Bí Chi Chủ", synopsis: "Truyện về thế giới quỷ bí ẩn" },
  { id: 2, name: "Quy Bi Chi Chu", synopsis: "Tên không dấu hoàn toàn khác" },
  { id: 3, name: "Quỹ Bỉ Chỉ Chũ", synopsis: "Dấu khác nhưng cùng gốc" },
  { id: 4, name: "Đấu La Đại Lục", synopsis: "Truyện tiên hiệp nổi tiếng" },
  { id: 5, name: "Đấu Phá Thương Khung", synopsis: "Một bộ truyện khác" },
  { id: 6, name: "Quỷ Vương Trở Về", synopsis: "Quỷ vương phục sinh" },
  { id: 7, name: "Chủ Tịch Tổng Giám Đốc", synopsis: "Truyện ngôn tình" },
  {
    id: 8,
    name: "Toàn Chức Pháp Sư",
    synopsis: "Thế giới ma thuật chi bí mật",
  },
  { id: 9, name: "Vạn Cổ Chí Tôn", synopsis: "Tu tiên chi lộ" },
  {
    id: 10,
    name: "Thiên Đạo Đồ Thư Quán",
    synopsis: "Thư quỷ bí chi chủ nhân",
  },
];

// ── setup ────────────────────────────────────────────────────────────────────

function createDb(removeDiacritics: number): Database.Database {
  const db = new Database(":memory:");

  db.exec(`
    CREATE TABLE books (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      synopsis TEXT
    );
  `);

  const insert = db.prepare(
    "INSERT INTO books (id, name, synopsis) VALUES (?, ?, ?)",
  );
  for (const b of BOOKS) insert.run(b.id, b.name, b.synopsis);

  db.exec(`
    CREATE VIRTUAL TABLE books_fts USING fts5(
      name,
      synopsis,
      content='books',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics ${removeDiacritics}'
    );
    INSERT INTO books_fts(rowid, name, synopsis)
      SELECT id, name, synopsis FROM books;
  `);

  return db;
}

function search(
  db: Database.Database,
  query: string,
): { id: number; name: string }[] {
  return db
    .prepare(
      `SELECT books.id, books.name
         FROM books_fts
         JOIN books ON books.id = books_fts.rowid
        WHERE books_fts MATCH ?
        ORDER BY rank
        LIMIT 20`,
    )
    .all(query) as { id: number; name: string }[];
}

// ── tests ────────────────────────────────────────────────────────────────────

function testDiacriticsPreserved() {
  console.log(
    "\n── remove_diacritics 0 (FIXED — preserves Vietnamese tones) ──",
  );
  const db = createDb(0);

  // Exact match (mixed case — unicode61 still lowercases)
  const q1 = buildFtsQuery("Quỷ Bí Chi Chủ");
  const r1 = search(db, q1);
  assert(
    r1.length >= 1,
    `"Quỷ Bí Chi Chủ" returns at least 1 result (got ${r1.length})`,
  );
  assert(
    r1[0]?.id === 1,
    `First result is "Quỷ Bí Chi Chủ" (id=1), got id=${r1[0]?.id}`,
  );

  // Lowercase exact match
  const q2 = buildFtsQuery("quỷ bí chi chủ");
  const r2 = search(db, q2);
  assert(
    r2.length >= 1,
    `"quỷ bí chi chủ" (lowercase) returns at least 1 result (got ${r2.length})`,
  );
  assert(r2[0]?.id === 1, `First result is id=1, got id=${r2[0]?.id}`);

  // Should NOT match the no-diacritic version
  const q3 = buildFtsQuery("Quy Bi Chi Chu");
  const r3 = search(db, q3);
  const hasId1 = r3.some((r) => r.id === 1);
  assert(
    !hasId1,
    `"Quy Bi Chi Chu" (no diacritics) does NOT match id=1 "Quỷ Bí Chi Chủ"`,
  );
  const hasId2 = r3.some((r) => r.id === 2);
  assert(
    hasId2,
    `"Quy Bi Chi Chu" matches id=2 "Quy Bi Chi Chu" (the no-diacritic book)`,
  );

  // Different tones should NOT match
  const q4 = buildFtsQuery("Quỹ Bỉ Chỉ Chũ");
  const r4 = search(db, q4);
  const r4HasId1 = r4.some((r) => r.id === 1);
  assert(!r4HasId1, `"Quỹ Bỉ Chỉ Chũ" (different tones) does NOT match id=1`);
  const r4HasId3 = r4.some((r) => r.id === 3);
  assert(r4HasId3, `"Quỹ Bỉ Chỉ Chũ" matches id=3 "Quỹ Bỉ Chỉ Chũ"`);

  // Partial name search
  const q5 = buildFtsQuery("Đấu La");
  const r5 = search(db, q5);
  assert(
    r5.length >= 1,
    `"Đấu La" returns at least 1 result (got ${r5.length})`,
  );
  assert(r5[0]?.id === 4, `First result for "Đấu La" is id=4 "Đấu La Đại Lục"`);

  // Single-word search with diacritics
  const q6 = buildFtsQuery("Quỷ");
  const r6 = search(db, q6);
  const r6Ids = new Set(r6.map((r) => r.id));
  assert(r6Ids.has(1), `"Quỷ" matches id=1 (name contains Quỷ)`);
  assert(r6Ids.has(6), `"Quỷ" matches id=6 (name contains Quỷ)`);
  assert(
    !r6Ids.has(2),
    `"Quỷ" does NOT match id=2 "Quy Bi Chi Chu" (no diacritics)`,
  );

  db.close();
}

function testDiacriticsRemoved_showsBug() {
  console.log("\n── remove_diacritics 1 (OLD — demonstrates the bug) ──");
  const db = createDb(1);

  // With diacritics removed, "Quỷ" → "quy", "Bí" → "bi", etc.
  // This matches WAY too broadly.
  const q1 = buildFtsQuery("Quỷ Bí Chi Chủ");
  const r1 = search(db, q1);

  // The bug: books with matching base syllables pollute results
  // "chi" and "chủ" share base "chi"/"chu", very common in Vietnamese
  assert(
    r1.length > 1,
    `Old tokenizer returns ${r1.length} results for "Quỷ Bí Chi Chủ" (too broad)`,
  );

  // The no-diacritic variant incorrectly matches the diacritic book
  const matchesId1 = r1.some((r) => r.id === 1);
  const matchesId2 = r1.some((r) => r.id === 2);
  assert(
    matchesId1 && matchesId2,
    `Old tokenizer conflates id=1 "Quỷ Bí Chi Chủ" and id=2 "Quy Bi Chi Chu"`,
  );

  // "Quỹ Bỉ Chỉ Chũ" also incorrectly matches because all diacritics
  // are stripped to the same base forms
  const q2 = buildFtsQuery("Quỹ Bỉ Chỉ Chũ");
  const r2 = search(db, q2);
  const r2HasId1 = r2.some((r) => r.id === 1);
  assert(
    r2HasId1,
    `Old tokenizer: "Quỹ Bỉ Chỉ Chũ" INCORRECTLY matches id=1 (demonstrates the bug)`,
  );

  db.close();
}

function testFtsQuerySanitization() {
  console.log("\n── FTS query sanitization ──");

  // Normal Vietnamese input
  assert(
    buildFtsQuery("Quỷ Bí Chi Chủ") === '"Quỷ" "Bí" "Chi" "Chủ"',
    "Normal Vietnamese words wrapped in quotes",
  );

  // Input with special characters stripped
  assert(
    buildFtsQuery('Quỷ "Bí" (Chi) Chủ') === '"Quỷ" "Bí" "Chi" "Chủ"',
    "Special chars (quotes, parens) removed",
  );

  // Multiple spaces collapsed
  assert(
    buildFtsQuery("  Quỷ   Bí  ") === '"Quỷ" "Bí"',
    "Extra whitespace collapsed",
  );

  // Empty after sanitization
  assert(buildFtsQuery('""') === "", "Only special chars → empty query");

  // Smart quotes removed
  assert(
    buildFtsQuery("\u201CQuỷ\u201D") === '"Quỷ"',
    "Smart quotes (Unicode) stripped",
  );

  // Asterisks removed (FTS5 prefix operator)
  assert(buildFtsQuery("Quỷ*") === '"Quỷ"', "Asterisk stripped");

  // Caret removed (FTS5 column filter)
  assert(
    buildFtsQuery("^name:Quỷ") === '"nameQuỷ"',
    "Caret and colon stripped",
  );
}

function testCaseInsensitiveVietnamese() {
  console.log("\n── Case-insensitive Vietnamese search ──");
  const db = createDb(0);

  // ALL CAPS
  const q1 = buildFtsQuery("QUỶ BÍ CHI CHỦ");
  const r1 = search(db, q1);
  assert(
    r1.length >= 1,
    `ALL CAPS "QUỶ BÍ CHI CHỦ" returns results (got ${r1.length})`,
  );
  assert(r1[0]?.id === 1, `ALL CAPS first result is id=1`);

  // all lower
  const q2 = buildFtsQuery("quỷ bí chi chủ");
  const r2 = search(db, q2);
  assert(
    r2.length >= 1,
    `all lower "quỷ bí chi chủ" returns results (got ${r2.length})`,
  );
  assert(r2[0]?.id === 1, `all lower first result is id=1`);

  // mIxEd CaSe
  const q3 = buildFtsQuery("qUỶ bÍ cHi cHỦ");
  const r3 = search(db, q3);
  assert(r3.length >= 1, `mixed case returns results (got ${r3.length})`);
  assert(r3[0]?.id === 1, `mixed case first result is id=1`);

  db.close();
}

function testSynopsisSearch() {
  console.log("\n── Synopsis search (diacritics preserved) ──");
  const db = createDb(0);

  // Search term that appears only in synopsis
  const q1 = buildFtsQuery("tiên hiệp");
  const r1 = search(db, q1);
  assert(
    r1.length >= 1,
    `"tiên hiệp" finds book via synopsis (got ${r1.length})`,
  );
  assert(
    r1[0]?.id === 4,
    `Result is id=4 "Đấu La Đại Lục" (synopsis mentions tiên hiệp)`,
  );

  // "tiên hiệp" should NOT match "tiên hiêp" (different diacritics)
  // — but both words must be present, so a partial check suffices
  const q2 = buildFtsQuery("tiên hiêp");
  const r2 = search(db, q2);
  assert(
    r2.length === 0,
    `"tiên hiêp" (wrong diacritic on hiêp) returns 0 results`,
  );

  db.close();
}

function testHighlightFunction() {
  console.log("\n── highlight() works with preserved diacritics ──");
  const db = createDb(0);

  const q = buildFtsQuery("Quỷ Bí");
  const rows = db
    .prepare(
      `SELECT highlight(books_fts, 0, '<mark>', '</mark>') AS hl_name
         FROM books_fts
         JOIN books ON books.id = books_fts.rowid
        WHERE books_fts MATCH ?
        ORDER BY rank
        LIMIT 5`,
    )
    .all(q) as { hl_name: string }[];

  assert(rows.length >= 1, `highlight query returns results`);
  const hl = rows[0]?.hl_name ?? "";
  assert(
    hl.includes("<mark>") && hl.includes("</mark>"),
    `highlight output contains <mark> tags: "${hl}"`,
  );
  assert(
    hl.includes("Quỷ") || hl.includes("quỷ"),
    `highlight preserves Vietnamese diacritics: "${hl}"`,
  );

  db.close();
}

// ── run ──────────────────────────────────────────────────────────────────────

console.log("🔍 FTS5 Vietnamese search tests\n");

testDiacriticsPreserved();
testDiacriticsRemoved_showsBug();
testFtsQuerySanitization();
testCaseInsensitiveVietnamese();
testSynopsisSearch();
testHighlightFunction();

console.log(`\n${"─".repeat(50)}`);
console.log(
  `Results: ${passed} passed, ${failed} failed out of ${passed + failed}`,
);

if (failed > 0) {
  console.error("\n💥 Some tests failed!");
  process.exit(1);
} else {
  console.log("\n🎉 All tests passed!");
}
