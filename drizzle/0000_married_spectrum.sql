CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`event_date` text NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`start_time` text,
	`end_time` text,
	`category` text DEFAULT 'personal' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_user_date_idx` ON `events` (`user_id`,`event_date`);--> statement-breakpoint
CREATE INDEX `events_user_title_idx` ON `events` (`user_id`,`title`);