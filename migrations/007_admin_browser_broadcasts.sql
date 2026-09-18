CREATE TABLE IF NOT EXISTS admin_browser_tokens (
  token_hash text PRIMARY KEY,
  admin_telegram_id bigint NOT NULL,
  first_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('login','session')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_browser_expiry ON admin_browser_tokens(expires_at);

CREATE TABLE IF NOT EXISTS broadcast_templates (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  text_ru text NOT NULL,
  text_uz text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO broadcast_templates(name,text_ru,text_uz) VALUES
  ('Бот снова работает', E'✅ Бот снова работает!\n\nМожете пользоваться всеми функциями. Нажмите /start, чтобы открыть меню.',
   E'✅ Bot yana ishlayapti!\n\nBarcha funksiyalardan foydalanishingiz mumkin. Menyuni ochish uchun /start ni bosing.')
ON CONFLICT(name) DO NOTHING;

CREATE TABLE IF NOT EXISTS broadcasts (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  admin_telegram_id bigint NOT NULL,
  started_by bigint,
  text_ru text NOT NULL,
  text_uz text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('all','selected')),
  selected_ids jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS broadcast_recipients (
  broadcast_id bigint NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_id bigint NOT NULL,
  language text NOT NULL CHECK (language IN ('ru','uz')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','unknown','cancelled')),
  telegram_message_id bigint,
  error_code text,
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(broadcast_id,user_id)
);
CREATE INDEX IF NOT EXISTS broadcast_pending ON broadcast_recipients(status,broadcast_id,user_id);
CREATE TABLE IF NOT EXISTS broadcast_clock (
  id integer PRIMARY KEY CHECK (id=1),
  next_send_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO broadcast_clock(id) VALUES(1) ON CONFLICT DO NOTHING;
