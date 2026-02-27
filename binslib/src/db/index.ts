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
// The tokenizer uses  remove_diacritics 2  so that searches work both WITH
// and WITHOUT Vietnamese diacritics.  This is critical for the vbook Android
// extension whose JS runtime may strip diacritics from user input — e.g.
// "thế giới" becomes "the gioi".
//
// Additionally, đ/Đ are replaced with d/D in the indexed content and
// triggers because the unicode61 tokenizer treats the Vietnamese đ
// (d-with-stroke) as a letter variant, not a combining diacritic, so
// remove_diacritics does NOT map đ→d on its own.
//
// This must stay in sync with scripts/migrate.ts which performs the same
// FTS setup.  This check runs once at startup and is a no-op when the
// table is already configured correctly.

function ensureFts() {
  // If the books table doesn't exist yet (fresh DB before migrations),
  // skip — migrate.ts will create the FTS table from scratch.
  const booksTable = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='books'",
    )
    .get() as { name: string } | undefined;
  if (!booksTable) return;

  const CORRECT_TOKENIZER = "unicode61 remove_diacritics 2";

  // Check whether books_fts exists and uses the correct tokenizer.
  const ftsRow = sqlite
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='books_fts'",
    )
    .get() as { sql: string } | undefined;

  if (ftsRow && ftsRow.sql.includes("remove_diacritics 2")) {
    // Already correct — nothing to do.
    return;
  }

  // Either the FTS table is missing or uses the wrong tokenizer.
  // Rebuild from scratch using separate exec() calls — a single
  // multi-statement exec() silently fails to DROP the FTS virtual
  // table in some environments.
  console.log(
    "[db/index] FTS table missing or has wrong tokenizer. Rebuilding...",
  );

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

  // Populate with đ/Đ → d/D normalization.
  // highlight() still reads the original name from the books table,
  // so displayed results keep the correct đ/Đ characters.
  sqlite.exec(`
    INSERT INTO books_fts(rowid, name)
      SELECT id, REPLACE(REPLACE(name, 'đ', 'd'), 'Đ', 'D') FROM books
  `);

  // Triggers with the same đ→d normalization
  sqlite.exec(`
    CREATE TRIGGER books_ai AFTER INSERT ON books BEGIN
      INSERT INTO books_fts(rowid, name)
        VALUES (new.id, REPLACE(REPLACE(new.name, 'đ', 'd'), 'Đ', 'D'));
    END
  `);
  sqlite.exec(`
    CREATE TRIGGER books_ad AFTER DELETE ON books BEGIN
      INSERT INTO books_fts(books_fts, rowid, name)
        VALUES ('delete', old.id, REPLACE(REPLACE(old.name, 'đ', 'd'), 'Đ', 'D'));
    END
  `);
  sqlite.exec(`
    CREATE TRIGGER books_au AFTER UPDATE ON books BEGIN
      INSERT INTO books_fts(books_fts, rowid, name)
        VALUES ('delete', old.id, REPLACE(REPLACE(old.name, 'đ', 'd'), 'Đ', 'D'));
      INSERT INTO books_fts(rowid, name)
        VALUES (new.id, REPLACE(REPLACE(new.name, 'đ', 'd'), 'Đ', 'D'));
    END
  `);

  console.log("[db/index] FTS rebuilt with remove_diacritics 2 + đ→d.");
}

try {
  ensureFts();
} catch (err) {
  // Log but don't crash — FTS rebuild is best-effort at init time.
  // migrate.ts will handle it on the next explicit migration run.
  console.error("[db/index] FTS rebuild failed:", err);
}

export const db = drizzle(sqlite, { schema });
export { sqlite };
