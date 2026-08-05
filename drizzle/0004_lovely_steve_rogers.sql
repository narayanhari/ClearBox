CREATE TABLE IF NOT EXISTS `sync_chunks` (
	`user_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`message_ids_json` text NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`next_page_token` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
