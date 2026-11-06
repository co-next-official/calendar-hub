CREATE TABLE `event_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_invites_token_hash_unique` ON `event_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `event_invites_event_idx` ON `event_invites` (`event_id`);--> statement-breakpoint
CREATE TABLE `event_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`email` text,
	`guest_name` text,
	`guest_key_hash` text,
	`invite_id` text,
	`response` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`responded_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "event_participants_who" CHECK(("event_participants"."email" is not null) or ("event_participants"."guest_name" is not null and "event_participants"."guest_key_hash" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_participants_event_email_idx` ON `event_participants` (`event_id`,`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_participants_guest_idx` ON `event_participants` (`event_id`,`guest_key_hash`);--> statement-breakpoint
CREATE INDEX `event_participants_email_idx` ON `event_participants` (`email`);--> statement-breakpoint
ALTER TABLE `events` ADD `group_id` text;