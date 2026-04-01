-- Idempotent: add columns only if they don't already exist (MySQL 8.0+)
ALTER TABLE `material_chunks`
  ADD COLUMN IF NOT EXISTS `startOffset` int DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `endOffset` int DEFAULT NULL;

ALTER TABLE `queries`
  ADD COLUMN IF NOT EXISTS `conversationId` varchar(64) DEFAULT NULL;

CREATE INDEX IF NOT EXISTS `queries_conversationId_idx` ON `queries` (`conversationId`);
