import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DATABASE_URL?.replace("file:", "") || "./data/binslib.db";
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
sqlite.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
    name,
    synopsis,
    content='books',
    content_rowid='id',
    tokenize='unicode61'
  );

  -- Triggers to keep books FTS in sync
  CREATE TRIGGER IF NOT EXISTS books_ai AFTER INSERT ON books BEGIN
    INSERT INTO books_fts(rowid, name, synopsis) VALUES (new.id, new.name, new.synopsis);
  END;
  CREATE TRIGGER IF NOT EXISTS books_ad AFTER DELETE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, name, synopsis) VALUES('delete', old.id, old.name, old.synopsis);
  END;
  CREATE TRIGGER IF NOT EXISTS books_au AFTER UPDATE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, name, synopsis) VALUES('delete', old.id, old.name, old.synopsis);
    INSERT INTO books_fts(rowid, name, synopsis) VALUES (new.id, new.name, new.synopsis);
  END;

  -- Clean up chapter FTS (bodies now stored on disk, not in DB)
  DROP TRIGGER IF EXISTS chapters_ai;
  DROP TRIGGER IF EXISTS chapters_ad;
  DROP TRIGGER IF EXISTS chapters_au;
  DROP TABLE IF EXISTS chapters_fts;
`);

console.log("Migrations complete.");
sqlite.close();
