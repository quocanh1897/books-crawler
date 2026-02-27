import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import fs from "fs";

const DB_PATH =
  process.env.DATABASE_URL?.replace("file:", "") || "./data/binslib.db";
const resolvedPath = path.resolve(DB_PATH);

// Ensure data directory exists
fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

const sqlite = new Database(resolvedPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite);

console.log("Running migrations...");
migrate(db, { migrationsFolder: "./src/db/migrations" });
console.log("Drizzle migrations applied.");

// Create FTS5 virtual tables (not handled by Drizzle)
//
// The tokenizer uses  remove_diacritics 2  so that searches work both
// WITH and WITHOUT Vietnamese diacritics.  This is critical for the
// vbook-extension whose Android JS runtime may strip diacritics from
// user input before passing it to the search script — e.g. the user
// types "thế giới" but the extension receives "the gioi".
//
// With remove_diacritics 2, both "thế giới" and "the gioi" match
// "Thế Giới" in the index.  Single-syllable queries like "quy" will
// match "Quỷ" too (less precise), but multi-word queries are still
// selective enough for good results.
//
// Because changing the tokenizer requires rebuilding the entire FTS index,
// we unconditionally drop + recreate the table and repopulate from `books`.

// Split into individual exec() calls — a single multi-statement exec()
// silently fails to DROP the FTS virtual table in some environments,
// leaving the old tokenizer (remove_diacritics 0) in place.

// Step 1: Drop old triggers (must happen before dropping FTS table)
sqlite.exec(`DROP TRIGGER IF EXISTS books_ai`);
sqlite.exec(`DROP TRIGGER IF EXISTS books_ad`);
sqlite.exec(`DROP TRIGGER IF EXISTS books_au`);

// Step 2: Drop old FTS table (may have wrong tokenizer)
sqlite.exec(`DROP TABLE IF EXISTS books_fts`);

console.log("Old FTS table dropped.");

// Step 3: Recreate with diacritics-tolerant tokenizer
sqlite.exec(`
  CREATE VIRTUAL TABLE books_fts USING fts5(
    name,
    content='books',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  )
`);

console.log("New FTS table created (remove_diacritics 2).");

// Step 4: Repopulate from existing book rows.
// REPLACE đ/Đ → d/D because the unicode61 tokenizer treats the stroke
// as a letter variant, not a combining diacritic, so remove_diacritics
// does NOT map đ→d.  Vietnamese keyboards on Android may strip đ→d in
// search input, so the index must match both forms.
// highlight() still reads the original name from the books table, so
// displayed results keep the correct đ/Đ characters.
sqlite.exec(`
  INSERT INTO books_fts(rowid, name)
    SELECT id, REPLACE(REPLACE(name, 'đ', 'd'), 'Đ', 'D') FROM books
`);

console.log("FTS index populated.");

// Step 5: Triggers to keep books FTS in sync (same đ→d normalization)
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

console.log("FTS triggers created.");

// Step 6: Clean up chapter FTS (bodies now stored on disk, not in DB)
sqlite.exec(`DROP TRIGGER IF EXISTS chapters_ai`);
sqlite.exec(`DROP TRIGGER IF EXISTS chapters_ad`);
sqlite.exec(`DROP TRIGGER IF EXISTS chapters_au`);
sqlite.exec(`DROP TABLE IF EXISTS chapters_fts`);

// ── Verification ───────────────────────────────────────────────────────────
// Three checks to catch silent failures in the exec block above:
//   1. Tokenizer must be remove_diacritics 2 (not 0)
//   2. đ→d normalization: "đồ" should NOT match, "dồ" SHOULD match
//   3. Diacritics stripping: "the" should match "Thế" (via tokenizer)

const totalBooks = sqlite.prepare(`SELECT COUNT(*) as n FROM books`).get() as {
  n: number;
};

// Check 1: Tokenizer definition
const ftsDef = sqlite
  .prepare(`SELECT sql FROM sqlite_master WHERE name = 'books_fts'`)
  .get() as { sql: string } | undefined;
const hasCorrectTokenizer = ftsDef?.sql?.includes("remove_diacritics 2");

if (!hasCorrectTokenizer) {
  console.error(
    `FATAL: FTS table has wrong tokenizer! Expected remove_diacritics 2, got:`,
    ftsDef?.sql?.substring(0, 200),
  );
  console.log("Forcing complete FTS rebuild with separate statements...");

  // The multi-statement exec may have failed — try individual statements
  try {
    sqlite.exec(`DROP TRIGGER IF EXISTS books_ai`);
  } catch {}
  try {
    sqlite.exec(`DROP TRIGGER IF EXISTS books_ad`);
  } catch {}
  try {
    sqlite.exec(`DROP TRIGGER IF EXISTS books_au`);
  } catch {}
  try {
    sqlite.exec(`DROP TABLE IF EXISTS books_fts`);
  } catch {}

  sqlite.exec(
    `CREATE VIRTUAL TABLE books_fts USING fts5(name, content='books', content_rowid='id', tokenize='unicode61 remove_diacritics 2')`,
  );
  sqlite.exec(
    `INSERT INTO books_fts(rowid, name) SELECT id, REPLACE(REPLACE(name, 'đ', 'd'), 'Đ', 'D') FROM books`,
  );

  sqlite.exec(
    `CREATE TRIGGER books_ai AFTER INSERT ON books BEGIN INSERT INTO books_fts(rowid, name) VALUES (new.id, REPLACE(REPLACE(new.name, 'đ', 'd'), 'Đ', 'D')); END`,
  );
  sqlite.exec(
    `CREATE TRIGGER books_ad AFTER DELETE ON books BEGIN INSERT INTO books_fts(books_fts, rowid, name) VALUES('delete', old.id, REPLACE(REPLACE(old.name, 'đ', 'd'), 'Đ', 'D')); END`,
  );
  sqlite.exec(
    `CREATE TRIGGER books_au AFTER UPDATE ON books BEGIN INSERT INTO books_fts(books_fts, rowid, name) VALUES('delete', old.id, REPLACE(REPLACE(old.name, 'đ', 'd'), 'Đ', 'D')); INSERT INTO books_fts(rowid, name) VALUES (new.id, REPLACE(REPLACE(new.name, 'đ', 'd'), 'Đ', 'D')); END`,
  );

  console.log("  FTS force-rebuilt with individual statements.");
}

// Check 2: đ→d normalization
const verifyOld = sqlite
  .prepare(`SELECT COUNT(*) as n FROM books_fts WHERE books_fts MATCH '"đồ"'`)
  .get() as { n: number };
const verifyNew = sqlite
  .prepare(`SELECT COUNT(*) as n FROM books_fts WHERE books_fts MATCH '"dồ"'`)
  .get() as { n: number };

if (verifyOld.n > 0 && verifyNew.n === 0) {
  console.warn(
    `FTS đ→d check FAILED: "đồ" matched ${verifyOld.n} rows, "dồ" matched 0. Re-inserting...`,
  );
  sqlite.exec(`DELETE FROM books_fts`);
  sqlite.exec(
    `INSERT INTO books_fts(rowid, name) SELECT id, REPLACE(REPLACE(name, 'đ', 'd'), 'Đ', 'D') FROM books`,
  );
  const recheck = sqlite
    .prepare(`SELECT COUNT(*) as n FROM books_fts WHERE books_fts MATCH '"dồ"'`)
    .get() as { n: number };
  console.log(`  FTS re-populated: "dồ" now matches ${recheck.n} rows.`);
}

// Check 3: Diacritics stripping (the real user-facing test)
const verifyStripped = sqlite
  .prepare(
    `SELECT COUNT(*) as n FROM books_fts WHERE books_fts MATCH '"the" "gioi"'`,
  )
  .get() as { n: number };
const verifyExact = sqlite
  .prepare(
    `SELECT COUNT(*) as n FROM books_fts WHERE books_fts MATCH '"thế" "giới"'`,
  )
  .get() as { n: number };

const ftsDef2 = sqlite
  .prepare(`SELECT sql FROM sqlite_master WHERE name = 'books_fts'`)
  .get() as { sql: string } | undefined;

console.log(
  `FTS verified: ${totalBooks.n} books indexed, ` +
    `tokenizer=${ftsDef2?.sql?.includes("remove_diacritics 2") ? "OK" : "WRONG"}, ` +
    `đ→d=(đồ=${verifyOld.n}, dồ=${verifyNew.n}), ` +
    `diacritics=(exact=${verifyExact.n}, stripped=${verifyStripped.n}).`,
);

if (verifyStripped.n === 0 && verifyExact.n > 0) {
  console.error(
    "WARNING: Diacritics stripping NOT working! " +
      '"the gioi" returns 0 but "thế giới" returns results. ' +
      "The tokenizer may not be remove_diacritics 2.",
  );
}

console.log("Migrations complete.");
sqlite.close();
