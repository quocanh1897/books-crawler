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
// The tokenizer MUST use  remove_diacritics 0  so that Vietnamese tonal
// marks are preserved.  The default (remove_diacritics 1) strips diacritics,
// collapsing e.g. "Quỷ"→"quy", "Bí"→"bi" — extremely common syllables —
// which buries the correct result under thousands of irrelevant matches.
//
// Because changing the tokenizer requires rebuilding the entire FTS index,
// we unconditionally drop + recreate the table and repopulate from `books`.

sqlite.exec(`
  -- Drop old FTS infrastructure (may use the wrong tokenizer)
  DROP TRIGGER IF EXISTS books_ai;
  DROP TRIGGER IF EXISTS books_ad;
  DROP TRIGGER IF EXISTS books_au;
  DROP TABLE IF EXISTS books_fts;

  -- Recreate with diacritics preserved (critical for Vietnamese search)
  CREATE VIRTUAL TABLE books_fts USING fts5(
    name,
    content='books',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 0'
  );

  -- Repopulate from existing book rows
  INSERT INTO books_fts(rowid, name)
    SELECT id, name FROM books;

  -- Triggers to keep books FTS in sync
  CREATE TRIGGER books_ai AFTER INSERT ON books BEGIN
    INSERT INTO books_fts(rowid, name) VALUES (new.id, new.name);
  END;
  CREATE TRIGGER books_ad AFTER DELETE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, name) VALUES('delete', old.id, old.name);
  END;
  CREATE TRIGGER books_au AFTER UPDATE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, name) VALUES('delete', old.id, old.name);
    INSERT INTO books_fts(rowid, name) VALUES (new.id, new.name);
  END;

  -- Clean up chapter FTS (bodies now stored on disk, not in DB)
  DROP TRIGGER IF EXISTS chapters_ai;
  DROP TRIGGER IF EXISTS chapters_ad;
  DROP TRIGGER IF EXISTS chapters_au;
  DROP TABLE IF EXISTS chapters_fts;
`);

console.log("Migrations complete.");
sqlite.close();
