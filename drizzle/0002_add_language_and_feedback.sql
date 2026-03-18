ALTER TABLE `materials` ADD `language` enum('zh','en') NOT NULL DEFAULT 'zh';
--> statement-breakpoint
CREATE TABLE `query_feedback` (
	`id` int AUTO_INCREMENT NOT NULL,
	`query_id` int NOT NULL,
	`helpful` tinyint NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `query_feedback_id` PRIMARY KEY(`id`)
);
