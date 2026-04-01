ALTER TABLE `queries` ADD COLUMN `conversationId` varchar(64) DEFAULT NULL;
CREATE INDEX `queries_conversationId_idx` ON `queries` (`conversationId`);
