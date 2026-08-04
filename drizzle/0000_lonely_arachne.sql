CREATE TABLE `cleanup_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`sender_email` text NOT NULL,
	`message_ids_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`undone_at` integer
);
--> statement-breakpoint
CREATE INDEX `cleanup_jobs_user_idx` ON `cleanup_jobs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`sender_email` text NOT NULL,
	`sender_name` text NOT NULL,
	`subject` text NOT NULL,
	`received_at` integer NOT NULL,
	`is_unread` integer DEFAULT false NOT NULL,
	`is_starred` integer DEFAULT false NOT NULL,
	`is_important` integer DEFAULT false NOT NULL,
	`labels_json` text NOT NULL,
	`sync_run_id` text NOT NULL,
	`trashed_at` integer
);
--> statement-breakpoint
CREATE INDEX `messages_user_sender_idx` ON `messages` (`user_id`,`sender_email`);--> statement-breakpoint
CREATE INDEX `messages_user_received_idx` ON `messages` (`user_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`refresh_token_encrypted` text NOT NULL,
	`history_id` text,
	`last_synced_at` integer,
	`sync_status` text DEFAULT 'idle' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);