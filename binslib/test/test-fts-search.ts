#!/usr/bin/env npx tsx
/**
 * Integration tests for FTS5 Vietnamese search.
 *
 * Verifies that the FTS tokenizer, đ→d normalization, diacritics
 * stripping, ensureFts() logic, triggers, and buildFtsQuery() all
 * work correctly together.
 *
 * Uses a temporary in-memory SQLite database — no side effects on
 * the production DB.
 *
 * Run:
 *   cd binslib
 *   npx tsx tests/test-fts-search.ts
 *
 * Or via npm script (if added):
 *   npm test
 */

import Database from "better-sqlite3";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── buildFtsQuery (copied from search route — must stay in sync) ───────────

function buildFtsQuery(q: string): string {
  return q
    .replace(/[\u201C\u201D\u2018\u2019"'()*^:]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`)
    .join(" ");
}

// ── ensureFts (copied from db/index.ts — must stay in sync) ────────────────

function ensureFts(sqlite: Database.Database): void {
  const booksTable = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='books'",
    )
    .get() as { name: string } | undefined;
  if (!booksTable) return;

  const CORRECT_TOKENIZER = "unicode61 remove_diacritics 2";

  const ftsRow = sqlite
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='books_fts'",
    )
    .get() as { sql: string } | undefined;

  if (ftsRow && ftsRow.sql.includes("remove_diacritics 2")) {
    return;
  }

  sqlite.exec(`DROP TRIGGER IF EXISTS books_ai`);
  sqlite.exec(`DROP TRIGGER IF EXISTS books_ad`);
  sqlite.exec(`DROP TRIGGER IF EXISTS books_au`);
  sqlite.exec(`DROP TABLE IF EXISTS books_fts`);

  sqlite.exec(`
    CREATE VIRTUAL TABLE books_fts USING fts5(
      name,
      content='books',
      content_rowid='id',
      tokenize='${CORRECT_TOKENIZER}'
    )
  `);

  sqlite.exec(`
    INSERT INTO books_fts(rowid, name)
      SELECT id, REPLACE(REPLACE(name, 'đ', 'd'), 'Đ', 'D') FROM books
  `);

  sqlite.exec(`
    CREATE TRIGGER books_ai AFTER INSERT ON books BEGIN
      INSERT INTO books_fts(rowid, name)
        VALUES (new.id, REPLACE(REPLACE(new.name, 'đ', 'd'), 'Đ', 'D'));
    END
  `);
  sqlite.exec(`
    CREATE TRIGGER books_ad AFTER DELETE ON books BEGIN
      INSERT INTO books_fts(books_fts, rowid, name)
        VALUES('delete', old.id, REPLACE(REPLACE(old.name, 'đ', 'd'), 'Đ', 'D'));
    END
  `);
  sqlite.exec(`
    CREATE TRIGGER books_au AFTER UPDATE ON books BEGIN
      INSERT INTO books_fts(books_fts, rowid, name)
        VALUES('delete', old.id, REPLACE(REPLACE(old.name, 'đ', 'd'), 'Đ', 'D'));
      INSERT INTO books_fts(rowid, name)
        VALUES (new.id, REPLACE(REPLACE(new.name, 'đ', 'd'), 'Đ', 'D'));
    END
  `);
}

// ── Test fixtures ──────────────────────────────────────────────────────────

const BOOKS = [
  { id: 1, name: "Đế Bá", slug: "de-ba" },
  { id: 2, name: "Thế Giới Hoàn Mỹ", slug: "the-gioi-hoan-my" },
  { id: 3, name: "Vô Hạn Khủng Bố", slug: "vo-han-khung-bo" },
  { id: 4, name: "Đấu Phá Thương Khung", slug: "dau-pha-thuong-khung" },
  { id: 5, name: "Quỷ Bí Chi Chủ", slug: "quy-bi-chi-chu" },
  { id: 6, name: "Mạnh Nhất Hệ Thống", slug: "manh-nhat-he-thong" },
  { id: 7, name: "Đồ Đệ Của Ta Đều Là Đại Lão", slug: "do-de-cua-ta" },
  { id: 8, name: "Thuỷ Nguyệt Động Thiên", slug: "thuy-nguyet-dong-thien" },
  { id: 9, name: "Goblin Slayer", slug: "goblin-slayer" },
  { id: 10, name: "Zombie Vương", slug: "zombie-vuong" },
  { id: 11, name: "Đại Đạo Triều Thiên", slug: "dai-dao-trieu-thien" },
  { id: 12, name: "Phàm Nhân Tu Tiên", slug: "phan-nhan-tu-tien" },
];

// ── Helpers ────────────────────────────────────────────────────────────────

let dbPath: string;
let db: Database.Database;

function createTestDb(): Database.Database {
  dbPath = path.join(os.tmpdir(), `binslib-fts-test-${Date.now()}.db`);
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // Minimal books table (only columns needed for FTS)
  sqlite.exec(`
    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT,
      source TEXT DEFAULT 'mtc'
    )
  `);

  // Insert test books
  const insert = sqlite.prepare(
    "INSERT INTO books (id, name, slug) VALUES (?, ?, ?)",
  );
  for (const b of BOOKS) {
    insert.run(b.id, b.name, b.slug);
  }

  return sqlite;
}

function ftsMatch(query: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM books_fts WHERE books_fts MATCH ?`)
    .get(query) as { n: number };
  return row.n;
}

function ftsMatchNames(query: string): string[] {
  const rows = db
    .prepare(
      `SELECT books.name FROM books_fts
       JOIN books ON books.id = books_fts.rowid
       WHERE books_fts MATCH ?
       ORDER BY books.id`,
    )
    .all(query) as { name: string }[];
  return rows.map((r) => r.name);
}

function getTokenizerSetting(): string | null {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='books_fts'`,
    )
    .get() as { sql: string } | undefined;
  if (!row) return null;
  const m = row.sql.match(/remove_diacritics (\d)/);
  return m ? m[1] : null;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("FTS5 Vietnamese Search", () => {
  before(() => {
    db = createTestDb();
    ensureFts(db);
  });

  after(() => {
    db.close();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(dbPath + "-wal");
      fs.unlinkSync(dbPath + "-shm");
    } catch {}
  });

  // ── Tokenizer ────────────────────────────────────────────────────────

  describe("tokenizer configuration", () => {
    it("uses remove_diacritics 2", () => {
      assert.equal(getTokenizerSetting(), "2");
    });

    it("FTS table definition contains correct tokenizer string", () => {
      const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE name='books_fts'`)
        .get() as { sql: string };
      assert.ok(
        row.sql.includes("remove_diacritics 2"),
        `Expected remove_diacritics 2 in: ${row.sql}`,
      );
    });
  });

  // ── Diacritics stripping (via tokenizer) ─────────────────────────────

  describe("diacritics stripping", () => {
    it('"thế giới" and "the gioi" return same results', () => {
      const exact = ftsMatch('"thế" "giới"');
      const stripped = ftsMatch('"the" "gioi"');
      assert.ok(exact > 0, "exact query should match");
      assert.equal(exact, stripped, "stripped should match same count");
    });

    it('"mạnh nhất" and "manh nhat" return same results', () => {
      const exact = ftsMatch('"mạnh" "nhất"');
      const stripped = ftsMatch('"manh" "nhat"');
      assert.ok(exact > 0, "exact query should match");
      assert.equal(exact, stripped);
    });

    it('"vô hạn" and "vo han" return same results', () => {
      const exact = ftsMatch('"vô" "hạn"');
      const stripped = ftsMatch('"vo" "han"');
      assert.ok(exact > 0);
      assert.equal(exact, stripped);
    });

    it('"quỷ bí" and "quy bi" return same results', () => {
      const exact = ftsMatch('"quỷ" "bí"');
      const stripped = ftsMatch('"quy" "bi"');
      assert.ok(exact > 0);
      assert.equal(exact, stripped);
    });

    it('"thuỷ" and "thuy" return same results', () => {
      const exact = ftsMatch('"thuỷ"');
      const stripped = ftsMatch('"thuy"');
      assert.ok(exact > 0);
      assert.equal(exact, stripped);
    });

    it("ASCII queries work unchanged", () => {
      assert.ok(ftsMatch('"goblin"') > 0);
      assert.ok(ftsMatch('"zombie"') > 0);
    });
  });

  // ── đ/Đ → d/D normalization ─────────────────────────────────────────

  describe("đ→d normalization", () => {
    it('"đế" should NOT match (đ not in index)', () => {
      assert.equal(ftsMatch('"đế"'), 0, "raw đ should not be in index");
    });

    it('"dế" should match (đ→d in index, ế→e by tokenizer)', () => {
      // "Đế Bá" → index has "de" "ba" (đ→d + remove_diacritics)
      assert.ok(ftsMatch('"de"') > 0, '"de" should match Đế');
    });

    it('"đồ" should NOT match, "dồ" and "do" should match', () => {
      assert.equal(ftsMatch('"đồ"'), 0, "raw đồ not in index");
      assert.ok(ftsMatch('"dồ"') > 0, "dồ should match (đ→d applied)");
      assert.ok(ftsMatch('"do"') > 0, "do should match (dồ→do by tokenizer)");
    });

    it('"đấu" → "dau" matches "Đấu Phá Thương Khung"', () => {
      const names = ftsMatchNames('"dau" "pha"');
      assert.ok(
        names.some((n) => n.includes("Đấu Phá")),
        `Expected "Đấu Phá" in results, got: ${names}`,
      );
    });

    it('"đại đạo" → "dai dao" matches', () => {
      const names = ftsMatchNames('"dai" "dao"');
      assert.ok(
        names.some((n) => n.includes("Đại Đạo")),
        `Expected "Đại Đạo" in results, got: ${names}`,
      );
    });
  });

  // ── buildFtsQuery ────────────────────────────────────────────────────

  describe("buildFtsQuery()", () => {
    it("wraps words in double quotes", () => {
      assert.equal(buildFtsQuery("hello world"), '"hello" "world"');
    });

    it("strips FTS5 operator characters", () => {
      assert.equal(buildFtsQuery('hello "world"'), '"hello" "world"');
      assert.equal(buildFtsQuery("a*b^c:d"), '"abcd"');
      assert.equal(buildFtsQuery("(test)"), '"test"');
    });

    it("normalizes đ→d and Đ→D (other diacritics preserved for tokenizer)", () => {
      // buildFtsQuery only replaces đ→d / Đ→D (stroke removal).
      // Other Vietnamese diacritics (ế, á, ồ, ệ, …) are left intact —
      // the FTS5 tokenizer's remove_diacritics 2 handles them at match time.
      assert.equal(buildFtsQuery("đế bá"), '"dế" "bá"');
      assert.equal(buildFtsQuery("Đấu Phá"), '"Dấu" "Phá"');
      assert.equal(buildFtsQuery("đồ đệ"), '"dồ" "dệ"');
    });

    it("preserves other Vietnamese diacritics (tokenizer handles them)", () => {
      // These diacritics are stripped by the FTS5 tokenizer, not buildFtsQuery
      assert.equal(buildFtsQuery("thế giới"), '"thế" "giới"');
      assert.equal(buildFtsQuery("mạnh nhất"), '"mạnh" "nhất"');
    });

    it("handles empty and whitespace-only input", () => {
      assert.equal(buildFtsQuery(""), "");
      assert.equal(buildFtsQuery("   "), "");
    });

    it("handles smart quotes", () => {
      assert.equal(buildFtsQuery("\u201Chello\u201D"), '"hello"');
    });

    it("end-to-end: buildFtsQuery output matches FTS index", () => {
      // Simulate what the search API does
      const userInput = "đấu phá";
      const ftsQuery = buildFtsQuery(userInput);
      const results = ftsMatch(ftsQuery);
      assert.ok(
        results > 0,
        `buildFtsQuery("${userInput}") → ${ftsQuery} should match, got ${results}`,
      );
    });

    it("end-to-end: stripped Vietnamese matches", () => {
      for (const [input, expectedBook] of [
        ["the gioi", "Thế Giới"],
        ["vo han", "Vô Hạn"],
        ["de ba", "Đế Bá"],
        ["manh nhat", "Mạnh Nhất"],
        ["quy bi", "Quỷ Bí"],
        ["dau pha", "Đấu Phá"],
        ["do de", "Đồ Đệ"],
        ["thuy", "Thuỷ"],
      ] as const) {
        const ftsQuery = buildFtsQuery(input);
        const names = ftsMatchNames(ftsQuery);
        assert.ok(
          names.some((n) => n.includes(expectedBook)),
          `"${input}" → ${ftsQuery} should find "${expectedBook}", got: [${names.join(", ")}]`,
        );
      }
    });
  });

  // ── Triggers ─────────────────────────────────────────────────────────

  describe("FTS triggers", () => {
    it("INSERT trigger applies đ→d normalization", () => {
      db.exec(
        `INSERT INTO books (id, name, slug) VALUES (100, 'Đường Đến Đỉnh Cao', 'duong-den-dinh-cao')`,
      );
      // "Đường" → "Duong" (đ→d) → tokenized to "duong" (diacritics stripped)
      assert.ok(ftsMatch('"duong"') > 0, "INSERT trigger should normalize đ→d");
      assert.equal(
        ftsMatch('"đường"'),
        0,
        "raw đ should not appear after INSERT",
      );
    });

    it("UPDATE trigger applies đ→d normalization", () => {
      db.exec(`UPDATE books SET name = 'Đỉnh Đạo Vô Song' WHERE id = 100`);
      // Old name should be removed from index
      assert.equal(
        ftsMatch('"duong" "den"'),
        0,
        "old name should be removed after UPDATE",
      );
      // New name should be indexed with đ→d
      assert.ok(
        ftsMatch('"dinh" "dao"') > 0,
        "new name should be indexed after UPDATE",
      );
    });

    it("DELETE trigger removes from index", () => {
      const before = ftsMatch('"dinh" "dao"');
      db.exec(`DELETE FROM books WHERE id = 100`);
      const after = ftsMatch('"dinh" "dao"');
      assert.equal(after, before - 1, "DELETE should remove from index");
    });
  });

  // ── ensureFts consistency ────────────────────────────────────────────

  describe("ensureFts()", () => {
    it("is a no-op when tokenizer is already correct", () => {
      const countBefore = ftsMatch('"the" "gioi"');
      ensureFts(db); // should not rebuild
      const countAfter = ftsMatch('"the" "gioi"');
      assert.equal(countAfter, countBefore, "ensureFts should be a no-op");
      assert.equal(getTokenizerSetting(), "2");
    });

    it("rebuilds if tokenizer is wrong (remove_diacritics 0)", () => {
      // Simulate the old broken state: force remove_diacritics 0
      db.exec(`DROP TRIGGER IF EXISTS books_ai`);
      db.exec(`DROP TRIGGER IF EXISTS books_ad`);
      db.exec(`DROP TRIGGER IF EXISTS books_au`);
      db.exec(`DROP TABLE IF EXISTS books_fts`);
      db.exec(`
        CREATE VIRTUAL TABLE books_fts USING fts5(
          name, content='books', content_rowid='id',
          tokenize='unicode61 remove_diacritics 0'
        )
      `);
      db.exec(`INSERT INTO books_fts(rowid, name) SELECT id, name FROM books`);

      // With remove_diacritics 0, stripped queries should NOT work
      assert.equal(getTokenizerSetting(), "0");
      const brokenResult = ftsMatch('"the" "gioi"');
      // "the" won't match "Thế" with remove_diacritics 0
      assert.equal(brokenResult, 0, "remove_diacritics 0 should fail");

      // Now run ensureFts — it should detect the wrong tokenizer and rebuild
      ensureFts(db);

      assert.equal(
        getTokenizerSetting(),
        "2",
        "ensureFts should fix tokenizer to 2",
      );
      const fixedResult = ftsMatch('"the" "gioi"');
      assert.ok(fixedResult > 0, "after ensureFts, stripped query should work");
    });

    it("rebuilds if FTS table is missing entirely", () => {
      db.exec(`DROP TRIGGER IF EXISTS books_ai`);
      db.exec(`DROP TRIGGER IF EXISTS books_ad`);
      db.exec(`DROP TRIGGER IF EXISTS books_au`);
      db.exec(`DROP TABLE IF EXISTS books_fts`);

      assert.equal(getTokenizerSetting(), null, "FTS table should not exist");

      ensureFts(db);

      assert.equal(getTokenizerSetting(), "2");
      assert.ok(ftsMatch('"the" "gioi"') > 0);
      assert.ok(ftsMatch('"do" "de"') > 0);
    });
  });

  // ── migrate.ts ↔ db/index.ts consistency ─────────────────────────────

  describe("migrate.ts ↔ db/index.ts consistency", () => {
    it("both files use the same tokenizer constant", () => {
      // Read both source files and check they agree
      const migrateTs = fs.readFileSync(
        path.join(__dirname, "..", "scripts", "migrate.ts"),
        "utf-8",
      );
      const dbIndexTs = fs.readFileSync(
        path.join(__dirname, "..", "src", "db", "index.ts"),
        "utf-8",
      );

      assert.ok(
        migrateTs.includes("remove_diacritics 2"),
        "migrate.ts should use remove_diacritics 2",
      );
      assert.ok(
        dbIndexTs.includes("remove_diacritics 2"),
        "db/index.ts should use remove_diacritics 2",
      );

      // Neither should still reference remove_diacritics 0 as the "correct" value
      assert.ok(
        !dbIndexTs.includes(
          'CORRECT_TOKENIZER = "unicode61 remove_diacritics 0"',
        ),
        "db/index.ts should NOT use remove_diacritics 0 as correct",
      );
    });

    it("both files normalize đ→d in FTS content", () => {
      const migrateTs = fs.readFileSync(
        path.join(__dirname, "..", "scripts", "migrate.ts"),
        "utf-8",
      );
      const dbIndexTs = fs.readFileSync(
        path.join(__dirname, "..", "src", "db", "index.ts"),
        "utf-8",
      );

      // Both should have REPLACE(name, 'đ', 'd') or equivalent
      const replacePattern = /REPLACE\(.*['\u0111'].*'d'/;
      assert.ok(
        replacePattern.test(migrateTs),
        "migrate.ts should have đ→d REPLACE",
      );
      assert.ok(
        replacePattern.test(dbIndexTs),
        "db/index.ts should have đ→d REPLACE",
      );
    });

    it("search route buildFtsQuery normalizes đ→d", () => {
      const searchRoute = fs.readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "search", "route.ts"),
        "utf-8",
      );
      assert.ok(
        searchRoute.includes('.replace(/đ/g, "d")'),
        "search route should normalize đ→d",
      );
      assert.ok(
        searchRoute.includes('.replace(/Đ/g, "D")'),
        "search route should normalize Đ→D",
      );
    });

    it("search page (tim-kiem) normalizes đ→d", () => {
      const searchPage = fs.readFileSync(
        path.join(__dirname, "..", "src", "app", "tim-kiem", "page.tsx"),
        "utf-8",
      );
      assert.ok(
        searchPage.includes('.replace(/đ/g, "d")'),
        "tim-kiem page should normalize đ→d",
      );
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("single character Vietnamese query works", () => {
      // "Vô" → stripped "vo" by tokenizer
      assert.ok(ftsMatch('"vô"') > 0);
    });

    it("mixed ASCII and Vietnamese query works", () => {
      // "Goblin" is ASCII, "Vương" is Vietnamese
      assert.ok(ftsMatch('"zombie" "vuong"') > 0);
    });

    it("query with only FTS operators returns empty (not error)", () => {
      const q = buildFtsQuery('***"":()^');
      assert.equal(q, "", "should produce empty query");
    });

    it("very long book name is searchable", () => {
      db.exec(`
        INSERT INTO books (id, name, slug)
        VALUES (200, 'Đây Là Một Cái Tên Truyện Rất Dài Để Kiểm Tra Khả Năng Tìm Kiếm Của Hệ Thống', 'long-name')
      `);
      assert.ok(ftsMatch('"day" "la" "mot"') > 0);
      assert.ok(ftsMatch('"tim" "kiem"') > 0);
      // Cleanup
      db.exec(`DELETE FROM books WHERE id = 200`);
    });

    it("book name with Chinese characters is searchable by Vietnamese name", () => {
      db.exec(`
        INSERT INTO books (id, name, slug)
        VALUES (201, 'Đoạn Kiếm Sơn', 'doan-kiem-son')
      `);
      assert.ok(ftsMatch('"doan" "kiem" "son"') > 0);
      // Cleanup
      db.exec(`DELETE FROM books WHERE id = 201`);
    });
  });
});
