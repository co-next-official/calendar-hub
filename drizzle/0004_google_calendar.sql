CREATE TABLE `google_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`calendar_id` text DEFAULT 'primary' NOT NULL,
	`google_email` text,
	`refresh_token_enc` text NOT NULL,
	`access_token_enc` text,
	`access_expires_at` text,
	`sync_token` text,
	`last_synced_at` text,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_connections_user_calendar_idx` ON `google_connections` (`user_id`,`calendar_id`);--> statement-breakpoint
ALTER TABLE `events` ADD `connection_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `external_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `events_connection_external_idx` ON `events` (`connection_id`,`external_id`);