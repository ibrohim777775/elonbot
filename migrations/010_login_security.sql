-- Per-user counters survive link replacement, disconnects and application restarts.
CREATE TABLE IF NOT EXISTS account_login_limits (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  code_sends integer NOT NULL DEFAULT 0 CHECK (code_sends >= 0)
);
