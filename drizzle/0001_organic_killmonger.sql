PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` text NOT NULL,
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
	`trashed_at` integer,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
INSERT INTO `__new_messages`("id", "user_id", "thread_id", "sender_email", "sender_name", "subject", "received_at", "is_unread", "is_starred", "is_important", "labels_json", "sync_run_id", "trashed_at") SELECT "id", "user_id", "thread_id", "sender_email", "sender_name", "subject", "received_at", "is_unread", "is_starred", "is_important", "labels_json", "sync_run_id", "trashed_at" FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `messages_user_sender_idx` ON `messages` (`user_id`,`sender_email`);--> statement-breakpoint
CREATE INDEX `messages_user_received_idx` ON `messages` (`user_id`,`received_at`);