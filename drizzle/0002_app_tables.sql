CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`op_id` text,
	`actor_id` text NOT NULL,
	`via` text NOT NULL,
	`type` text NOT NULL,
	`list_id` text NOT NULL,
	`item_id` text,
	`snapshot` text NOT NULL,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`notified_at` integer,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activity_pending_idx` ON `activity` (`actor_id`,`at`) WHERE "activity"."notified_at" IS NULL;--> statement-breakpoint
CREATE INDEX `activity_list_id_idx` ON `activity` (`list_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	`checked_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_via` text DEFAULT 'app' NOT NULL,
	`deleted_at` integer,
	`clocks` text DEFAULT '{}' NOT NULL,
	`seq` integer NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `items_seq_idx` ON `items` (`seq`);--> statement-breakpoint
CREATE INDEX `items_list_id_name_key_idx` ON `items` (`list_id`,`name_key`);--> statement-breakpoint
CREATE INDEX `items_name_key_idx` ON `items` (`name_key`);--> statement-breakpoint
CREATE TABLE `list_mutes` (
	`user_id` text NOT NULL,
	`list_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `list_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `list_mutes_list_id_idx` ON `list_mutes` (`list_id`);--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_via` text DEFAULT 'app' NOT NULL,
	`deleted_at` integer,
	`clocks` text DEFAULT '{}' NOT NULL,
	`seq` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lists_seq_idx` ON `lists` (`seq`);--> statement-breakpoint
CREATE TABLE `processed_ops` (
	`op_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`result` text,
	`processed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `processed_ops_processed_at_idx` ON `processed_ops` (`processed_at`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`device_label` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_success_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_id_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `server_seq` (
	`id` integer PRIMARY KEY NOT NULL,
	`value` integer NOT NULL,
	CONSTRAINT "server_seq_one_row" CHECK("server_seq"."id" = 1)
);
