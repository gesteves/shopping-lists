ALTER TABLE `push_subscriptions` ADD `failure_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `failing_since` integer;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `last_failure_at` integer;