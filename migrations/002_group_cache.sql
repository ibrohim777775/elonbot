-- Discovery cooldown is separate from message delivery and survives restarts.
-- Removing an account also removes its cached peers and access hashes.
CREATE TABLE IF NOT EXISTS telegram_group_cache (
  user_id bigint PRIMARY KEY REFERENCES telegram_accounts(user_id) ON DELETE CASCADE,
  groups jsonb,
  fetched_at timestamptz,
  retry_after timestamptz
);
