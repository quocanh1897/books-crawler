import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "path";

const DB_PATH =
  process.env.DATABASE_URL?.replace("file:", "") || "./data/binslib.db";
const resolvedPath = path.resolve(DB_PATH);

const sqlite = new Database(resolvedPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// ── Ensure FTS5 uses the correct tokenizer for Vietnamese ────────────────────
//
// The tokenizer MUST be  unicode61 remove_diacritics 0  so that Vietnamese
// tonal marks are preserved during indexing and search.  The old default
// (remove_diacritics 1) strips diacritics, collapsing e.g. "Quỷ"→"quy",
// "Bí"→"bi" — extremely common base syllables — which buries the correct
// result under thousands of irrelevant matches.
//
// This check runs once at startup and is a no-op when the table is already
// configured correctly.

function ensureFts() {
  // If the books table doesn't exist yet (fresh DB before migrations),
  // skip — migrate.ts will create the FTS table from scratch.
  const booksTable = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='books'",
    )
    .get() as { name: string } | undefined;
  if (!booksTable) return;

  const CORRECT_TOKENIZER = "unicode61 remove_diacritics 0";

  // Check whether books_fts exists and what tokenizer it uses.
  const ftsRow = sqlite
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='books_fts'",
    )
    .get() as { sql: string } | undefined;

  if (
    ftsRow &&
    ftsRow.sql.includes("remove_diacritics 0") &&
    !ftsRow.sql.includes("synopsis")
  ) {
    // Already correct — nothing to do.
    return;
  }

  // Either the FTS table is missing or uses the wrong tokenizer.
  // Rebuild it from scratch.
  sqlite.exec(`
    DROP TRIGGER IF EXISTS books_ai;
    DROP TRIGGER IF EXISTS books_ad;
    DROP TRIGGER IF EXISTS books_au;
    DROP TABLE IF EXISTS books_fts;

    CREATE VIRTUAL TABLE books_fts USING fts5(
      name,
      content='books',
      content_rowid='id',
      tokenize='${CORRECT_TOKENIZER}'
    );

    INSERT INTO books_fts(rowid, name)
      SELECT id, name FROM books;

    CREATE TRIGGER books_ai AFTER INSERT ON books BEGIN
      INSERT INTO books_fts(rowid, name)
        VALUES (new.id, new.name);
    END;

    CREATE TRIGGER books_ad AFTER DELETE ON books BEGIN
      INSERT INTO books_fts(books_fts, rowid, name)
        VALUES ('delete', old.id, old.name);
    END;

    CREATE TRIGGER books_au AFTER UPDATE ON books BEGIN
      INSERT INTO books_fts(books_fts, rowid, name)
        VALUES ('delete', old.id, old.name);
      INSERT INTO books_fts(rowid, name)
        VALUES (new.id, new.name);
    END;
  `);
}

try {
  ensureFts();
} catch {
  // Silently ignore — FTS rebuild is best-effort at init time.
  // migrate.ts will handle it on the next explicit migration run.
}

export const db = drizzle(sqlite, { schema });
export { sqlite };
