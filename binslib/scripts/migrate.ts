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

sqlite.exec(`
  -- Drop old FTS infrastructure (may use the wrong tokenizer)
  DROP TRIGGER IF EXISTS books_ai;
  DROP TRIGGER IF EXISTS books_ad;
  DROP TRIGGER IF EXISTS books_au;
  DROP TABLE IF EXISTS books_fts;

  -- Recreate with diacritics-tolerant tokenizer (matches with or without)
  CREATE VIRTUAL TABLE books_fts USING fts5(
    name,
    content='books',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );

  -- Repopulate from existing book rows.
  -- REPLACE đ/Đ → d/D because the unicode61 tokenizer treats the stroke
  -- as a letter variant, not a combining diacritic, so remove_diacritics
  -- does NOT map đ→d.  Vietnamese keyboards on Android may strip đ→d in
  -- search input, so the index must match both forms.
  -- highlight() still reads the original name from the books table, so
  -- displayed results keep the correct đ/Đ characters.
  INSERT INTO books_fts(rowid, name)
    SELECT id, REPLACE(REPLACE(name, 'đ', 'd'), 'Đ', 'D') FROM books;

  -- Triggers to keep books FTS in sync (same đ→d normalization)
  CREATE TRIGGER books_ai AFTER INSERT ON books BEGIN
    INSERT INTO books_fts(rowid, name)
      VALUES (new.id, REPLACE(REPLACE(new.name, 'đ', 'd'), 'Đ', 'D'));
  END;
  CREATE TRIGGER books_ad AFTER DELETE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, name)
      VALUES('delete', old.id, REPLACE(REPLACE(old.name, 'đ', 'd'), 'Đ', 'D'));
  END;
  CREATE TRIGGER books_au AFTER UPDATE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, name)
      VALUES('delete', old.id, REPLACE(REPLACE(old.name, 'đ', 'd'), 'Đ', 'D'));
    INSERT INTO books_fts(rowid, name)
      VALUES (new.id, REPLACE(REPLACE(new.name, 'đ', 'd'), 'Đ', 'D'));
  END;

  -- Clean up chapter FTS (bodies now stored on disk, not in DB)
  DROP TRIGGER IF EXISTS chapters_ai;
  DROP TRIGGER IF EXISTS chapters_ad;
  DROP TRIGGER IF EXISTS chapters_au;
  DROP TABLE IF EXISTS chapters_fts;
`);

console.log("Migrations complete.");
sqlite.close();
