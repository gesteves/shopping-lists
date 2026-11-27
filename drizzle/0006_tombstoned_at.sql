ALTER TABLE `items` ADD `tombstoned_at` integer;--> statement-breakpoint
ALTER TABLE `lists` ADD `tombstoned_at` integer;--> statement-breakpoint
-- The server time of the old deletes is not known. The time of the migration keeps each of them for the full 30 days.
UPDATE `items` SET `tombstoned_at` = CAST(strftime('%s', 'now') AS integer) * 1000 WHERE `deleted_at` IS NOT NULL;--> statement-breakpoint
UPDATE `lists` SET `tombstoned_at` = CAST(strftime('%s', 'now') AS integer) * 1000 WHERE `deleted_at` IS NOT NULL;
