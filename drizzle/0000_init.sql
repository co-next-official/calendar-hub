CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'personal' NOT NULL,
	`all_day` integer NOT NULL,
	`start_date` text,
	`end_date` text,
	`start_at` text,
	`end_at` text,
	`timezone` text DEFAULT 'Asia/Tokyo' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`busy_only` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'web' NOT NULL,
	`legacy_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "events_title_len" CHECK(length(trim("events"."title")) between 1 and 120),
	CONSTRAINT "events_notes_len" CHECK(length("events"."notes") <= 2000),
	CONSTRAINT "events_time_shape" CHECK((
    "events"."all_day" = 1 and "events"."start_date" is not null and "events"."end_date" is not null and "events"."start_date" < "events"."end_date"
      and "events"."start_at" is null and "events"."end_at" is null
  ) or (
    "events"."all_day" = 0 and "events"."start_at" is not null and "events"."end_at" is not null and "events"."start_at" < "events"."end_at"
      and "events"."start_date" is null and "events"."end_date" is null
  ))
);
--> statement-breakpoint
CREATE INDEX `events_owner_start_date_idx` ON `events` (`owner_id`,`start_date`);--> statement-breakpoint
CREATE INDEX `events_owner_start_at_idx` ON `events` (`owner_id`,`start_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_owner_legacy_idx` ON `events` (`owner_id`,`legacy_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_sub` text NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`avatar_url` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_login_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_unique` ON `users` (`google_sub`);