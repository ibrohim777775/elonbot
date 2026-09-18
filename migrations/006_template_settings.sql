-- Text-only templates remain intact and ask their owner to configure the missing settings once.
ALTER TABLE templates ADD COLUMN IF NOT EXISTS interval_minutes integer CHECK (interval_minutes > 0);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS first_run_mode first_run_mode;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS send_start_minute smallint;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS send_end_minute smallint;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS contact_phone varchar(32);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS contact_telegram varchar(255);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS contact_name varchar(255);
DO $$ BEGIN
  ALTER TABLE templates ADD CONSTRAINT ck_templates_sending_window CHECK (
    (send_start_minute IS NULL AND send_end_minute IS NULL) OR
    (send_start_minute IS NOT NULL AND send_end_minute IS NOT NULL AND
      send_start_minute >= 0 AND send_start_minute < 1440 AND
      send_end_minute >= 0 AND send_end_minute <= 1440 AND send_start_minute <> send_end_minute)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS template_groups (
  template_id bigint NOT NULL REFERENCES templates ON DELETE CASCADE,
  group_id bigint NOT NULL REFERENCES groups,
  PRIMARY KEY (template_id,group_id)
);
CREATE INDEX IF NOT EXISTS ix_template_groups_group_id ON template_groups(group_id);
