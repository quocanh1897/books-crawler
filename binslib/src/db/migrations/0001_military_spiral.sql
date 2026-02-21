ALTER TABLE `books` ADD `source` text DEFAULT 'mtc' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_books_source` ON `books` (`source`);