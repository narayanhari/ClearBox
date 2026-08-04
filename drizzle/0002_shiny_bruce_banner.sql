ALTER TABLE `users` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `sync_page_token` text;--> statement-breakpoint
ALTER TABLE `users` ADD `active_sync_run_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `sync_indexed_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `users` SET `owner_user_id` = `id` WHERE `owner_user_id` IS NULL;--> statement-breakpoint
CREATE INDEX `users_owner_idx` ON `users` (`owner_user_id`);
