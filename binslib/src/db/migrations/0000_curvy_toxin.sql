CREATE TABLE `authors` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`local_name` text,
	`avatar` text
);
--> statement-breakpoint
CREATE TABLE `book_genres` (
	`book_id` integer NOT NULL,
	`genre_id` integer NOT NULL,
	PRIMARY KEY(`book_id`, `genre_id`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`genre_id`) REFERENCES `genres`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_book_genres_genre` ON `book_genres` (`genre_id`);--> statement-breakpoint
CREATE TABLE `book_tags` (
	`book_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`book_id`, `tag_id`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `books` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`synopsis` text,
	`status` integer DEFAULT 1 NOT NULL,
	`status_name` text,
	`view_count` integer DEFAULT 0 NOT NULL,
	`comment_count` integer DEFAULT 0 NOT NULL,
	`bookmark_count` integer DEFAULT 0 NOT NULL,
	`vote_count` integer DEFAULT 0 NOT NULL,
	`review_score` real DEFAULT 0,
	`review_count` integer DEFAULT 0 NOT NULL,
	`chapter_count` integer DEFAULT 0 NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`cover_url` text,
	`author_id` integer,
	`created_at` text,
	`updated_at` text,
	`published_at` text,
	`new_chap_at` text,
	`chapters_saved` integer DEFAULT 0,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_books_slug` ON `books` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_books_view_count` ON `books` (`view_count`);--> statement-breakpoint
CREATE INDEX `idx_books_comment_count` ON `books` (`comment_count`);--> statement-breakpoint
CREATE INDEX `idx_books_bookmark_count` ON `books` (`bookmark_count`);--> statement-breakpoint
CREATE INDEX `idx_books_updated_at` ON `books` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_books_status` ON `books` (`status`);--> statement-breakpoint
CREATE TABLE `chapters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`index_num` integer NOT NULL,
	`title` text NOT NULL,
	`slug` text,
	`body` text,
	`word_count` integer DEFAULT 0,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chapters_book_index` ON `chapters` (`book_id`,`index_num`);--> statement-breakpoint
CREATE INDEX `idx_chapters_book` ON `chapters` (`book_id`);--> statement-breakpoint
CREATE TABLE `genres` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_genres_name` ON `genres` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_genres_slug` ON `genres` (`slug`);--> statement-breakpoint
CREATE TABLE `reading_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`book_id` integer NOT NULL,
	`chapter_index` integer NOT NULL,
	`read_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_reading_history_user` ON `reading_history` (`user_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `reading_progress` (
	`user_id` integer NOT NULL,
	`book_id` integer NOT NULL,
	`chapter_index` integer NOT NULL,
	`progress_pct` real DEFAULT 0,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `book_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type_id` integer
);
--> statement-breakpoint
CREATE TABLE `user_bookmarks` (
	`user_id` integer NOT NULL,
	`book_id` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `book_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`avatar` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_username` ON `users` (`username`);