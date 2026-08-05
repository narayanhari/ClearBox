CREATE TABLE `beta_members` (
	`email` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`invited_by` text,
	`invited_at` integer NOT NULL,
	`accepted_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `beta_members_status_idx` ON `beta_members` (`status`,`invited_at`);