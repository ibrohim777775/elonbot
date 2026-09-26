CREATE TABLE IF NOT EXISTS promotion_settings (
 id integer PRIMARY KEY CHECK (id=1), enabled boolean NOT NULL DEFAULT true,
 text_uz varchar(500) NOT NULL DEFAULT 'Bu xabar ushbu bot yordamida yuborildi:',
 text_ru varchar(500) NOT NULL DEFAULT 'Это сообщение отправлено с помощью этого бота:',
 revision integer NOT NULL DEFAULT 1, updated_by bigint, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO promotion_settings(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS promotion_enrollments (
 user_id bigint PRIMARY KEY REFERENCES users ON DELETE CASCADE,
 accepted_at timestamptz NOT NULL DEFAULT now(), ends_at timestamptz NOT NULL,
 settings_revision integer NOT NULL, language varchar(2) NOT NULL CHECK(language IN ('uz','ru')),
 footer text NOT NULL, sent_count integer NOT NULL DEFAULT 0 CHECK(sent_count BETWEEN 0 AND 100)
);
-- NULL means not prepared yet; an empty string freezes a delivery without a footer.
ALTER TABLE delivery_logs ADD COLUMN IF NOT EXISTS promotion_footer text;
CREATE INDEX IF NOT EXISTS ix_delivery_promotion_pending ON delivery_logs(announcement_id)
 WHERE status='rate_limited' AND promotion_footer<>'';
