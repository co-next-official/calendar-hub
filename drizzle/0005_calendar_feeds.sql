CREATE TABLE `calendar_feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_fetched_at` text,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_feeds_token_hash_unique` ON `calendar_feeds` (`token_hash`);--> statement-breakpoint
CREATE INDEX `calendar_feeds_user_idx` ON `calendar_feeds` (`user_id`);