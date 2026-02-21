import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";

// ─── Books ───────────────────────────────────────────────────────────────────

export const books = sqliteTable(
  "books",
  {
    id: integer("id").primaryKey(), // same as metruyencv book ID
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    synopsis: text("synopsis"),
    status: integer("status").notNull().default(1), // 1=ongoing, 2=completed, 3=paused
    statusName: text("status_name"),
    viewCount: integer("view_count").notNull().default(0),
    commentCount: integer("comment_count").notNull().default(0),
    bookmarkCount: integer("bookmark_count").notNull().default(0),
    voteCount: integer("vote_count").notNull().default(0),
    reviewScore: real("review_score").default(0),
    reviewCount: integer("review_count").notNull().default(0),
    chapterCount: integer("chapter_count").notNull().default(0),
    wordCount: integer("word_count").notNull().default(0),
    coverUrl: text("cover_url"),
    authorId: integer("author_id").references(() => authors.id),
    createdAt: text("created_at"),
    updatedAt: text("updated_at"),
    publishedAt: text("published_at"),
    newChapAt: text("new_chap_at"),
    chaptersSaved: integer("chapters_saved").default(0),
    metaHash: text("meta_hash"),
    source: text("source").notNull().default("mtc"),
  },
  (table) => [
    uniqueIndex("idx_books_slug").on(table.slug),
    index("idx_books_view_count").on(table.viewCount),
    index("idx_books_comment_count").on(table.commentCount),
    index("idx_books_bookmark_count").on(table.bookmarkCount),
    index("idx_books_updated_at").on(table.updatedAt),
    index("idx_books_status").on(table.status),
    index("idx_books_source").on(table.source),
  ]
);

// ─── Authors ─────────────────────────────────────────────────────────────────

export const authors = sqliteTable("authors", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  localName: text("local_name"),
  avatar: text("avatar"),
});

// ─── Genres ──────────────────────────────────────────────────────────────────

export const genres = sqliteTable(
  "genres",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
  },
  (table) => [
    uniqueIndex("idx_genres_name").on(table.name),
    uniqueIndex("idx_genres_slug").on(table.slug),
  ]
);

// ─── Book-Genre Junction ─────────────────────────────────────────────────────

export const bookGenres = sqliteTable(
  "book_genres",
  {
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    genreId: integer("genre_id")
      .notNull()
      .references(() => genres.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.bookId, table.genreId] }),
    index("idx_book_genres_genre").on(table.genreId),
  ]
);

// ─── Tags ────────────────────────────────────────────────────────────────────

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  typeId: integer("type_id"),
});

// ─── Book-Tag Junction ───────────────────────────────────────────────────────

export const bookTags = sqliteTable(
  "book_tags",
  {
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.bookId, table.tagId] })]
);

// ─── Chapters ────────────────────────────────────────────────────────────────

export const chapters = sqliteTable(
  "chapters",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    indexNum: integer("index_num").notNull(),
    title: text("title").notNull(),
    slug: text("slug"),
    body: text("body"),
    wordCount: integer("word_count").default(0),
  },
  (table) => [
    uniqueIndex("idx_chapters_book_index").on(table.bookId, table.indexNum),
    index("idx_chapters_book").on(table.bookId),
  ]
);

// ─── Users (auth) ────────────────────────────────────────────────────────────

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    avatar: text("avatar"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_users_email").on(table.email),
    uniqueIndex("idx_users_username").on(table.username),
  ]
);

// ─── User Bookmarks ──────────────────────────────────────────────────────────

export const userBookmarks = sqliteTable(
  "user_bookmarks",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [primaryKey({ columns: [table.userId, table.bookId] })]
);

// ─── Reading Progress ────────────────────────────────────────────────────────

export const readingProgress = sqliteTable(
  "reading_progress",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    chapterIndex: integer("chapter_index").notNull(),
    progressPct: real("progress_pct").default(0),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [primaryKey({ columns: [table.userId, table.bookId] })]
);

// ─── Reading History ─────────────────────────────────────────────────────────

export const readingHistory = sqliteTable(
  "reading_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    chapterIndex: integer("chapter_index").notNull(),
    readAt: text("read_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_reading_history_user").on(table.userId, table.readAt),
  ]
);
