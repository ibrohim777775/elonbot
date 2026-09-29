ALTER TABLE promotion_settings ADD COLUMN IF NOT EXISTS message_limit integer NOT NULL DEFAULT 100 CHECK(message_limit>0);
-- Freeze the quota alongside each accepted text. Existing agreements stay at 100.
ALTER TABLE promotion_enrollments ADD COLUMN IF NOT EXISTS message_limit integer NOT NULL DEFAULT 100 CHECK(message_limit>0);
ALTER TABLE promotion_enrollments DROP CONSTRAINT IF EXISTS promotion_enrollments_sent_count_check;
ALTER TABLE promotion_enrollments DROP CONSTRAINT IF EXISTS promotion_enrollments_count_limit_check;
ALTER TABLE promotion_enrollments ADD CONSTRAINT promotion_enrollments_count_limit_check CHECK(sent_count>=0 AND sent_count<=message_limit);
