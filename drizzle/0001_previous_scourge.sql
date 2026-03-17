CREATE TABLE `llm_configs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(128) NOT NULL,
	`provider` enum('openai','deepseek','qwen','ollama','custom') NOT NULL,
	`modelName` varchar(128) NOT NULL,
	`apiKey` text,
	`apiBaseUrl` text,
	`temperature` float DEFAULT 0.1,
	`maxTokens` int DEFAULT 4096,
	`embeddingModel` varchar(128),
	`embeddingApiKey` text,
	`embeddingBaseUrl` text,
	`isActive` boolean NOT NULL DEFAULT false,
	`isDefault` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `llm_configs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `material_chunks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`materialId` int NOT NULL,
	`chunkIndex` int NOT NULL,
	`content` text NOT NULL,
	`chapter` varchar(512),
	`pageStart` int,
	`pageEnd` int,
	`vectorId` varchar(256),
	`tokenCount` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `material_chunks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `materials` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` varchar(512) NOT NULL,
	`author` varchar(256),
	`publisher` varchar(256),
	`publishYear` varchar(16),
	`edition` varchar(64),
	`fileKey` varchar(1024) NOT NULL,
	`fileUrl` text NOT NULL,
	`fileSizeBytes` bigint,
	`status` enum('uploading','processing','published','error') NOT NULL DEFAULT 'uploading',
	`errorMessage` text,
	`totalChunks` int DEFAULT 0,
	`uploadedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `materials_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `queries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`question` text NOT NULL,
	`answer` text,
	`sources` json,
	`modelUsed` varchar(128),
	`responseTimeMs` int,
	`visitorIp` varchar(64),
	`visitorCity` varchar(128),
	`visitorRegion` varchar(128),
	`visitorCountry` varchar(64),
	`visitorLat` float,
	`visitorLng` float,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `queries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `upload_sessions` (
	`id` varchar(64) NOT NULL,
	`materialId` int,
	`filename` varchar(512) NOT NULL,
	`totalSize` bigint NOT NULL,
	`totalChunks` int NOT NULL,
	`uploadedChunks` int NOT NULL DEFAULT 0,
	`s3UploadId` varchar(512),
	`s3Parts` json,
	`status` enum('active','completed','aborted') NOT NULL DEFAULT 'active',
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `upload_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `visitor_stats` (
	`id` int AUTO_INCREMENT NOT NULL,
	`date` varchar(16) NOT NULL,
	`totalVisitors` int NOT NULL DEFAULT 0,
	`totalQueries` int NOT NULL DEFAULT 0,
	`cityDistribution` json,
	`countryDistribution` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `visitor_stats_id` PRIMARY KEY(`id`)
);
