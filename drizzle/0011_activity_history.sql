PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`op_id` text,
	`actor_id` text,
	`via` text NOT NULL,
	`type` text NOT NULL,
	`list_id` text NOT NULL,
	`item_id` text,
	`snapshot` text NOT NULL,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`op_at` integer NOT NULL,
	`notified_at` integer,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_activity`("id", "op_id", "actor_id", "via", "type", "list_id", "item_id", "snapshot", "at", "op_at", "notified_at") SELECT "id", "op_id", "actor_id", "via", "type", "list_id", "item_id", "snapshot", "at", "at", "notified_at" FROM `activity`;--> statement-breakpoint
DROP TABLE `activity`;--> statement-breakpoint
ALTER TABLE `__new_activity` RENAME TO `activity`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `activity_pending_idx` ON `activity` (`actor_id`,`at`) WHERE "activity"."notified_at" IS NULL;--> statement-breakpoint
CREATE INDEX `activity_op_at_idx` ON `activity` (`op_at`);--> statement-breakpoint
CREATE INDEX `activity_list_id_op_at_idx` ON `activity` (`list_id`,`op_at`);--> statement-breakpoint
CREATE INDEX `activity_item_id_op_at_idx` ON `activity` (`item_id`,`op_at`);