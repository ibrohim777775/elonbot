-- Existing announcements keep their round-the-clock schedule until the owner changes it.
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS send_start_minute smallint;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS send_end_minute smallint;
DO $$ BEGIN
  ALTER TABLE announcements ADD CONSTRAINT ck_announcements_sending_window CHECK (
    (send_start_minute IS NULL AND send_end_minute IS NULL) OR
    (send_start_minute IS NOT NULL AND send_end_minute IS NOT NULL AND
      send_start_minute >= 0 AND send_start_minute < 1440 AND
      send_end_minute >= 0 AND send_end_minute <= 1440 AND send_start_minute <> send_end_minute)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
