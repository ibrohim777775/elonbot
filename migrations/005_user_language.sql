ALTER TABLE users ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'uz' CHECK(language IN ('uz','ru'));
