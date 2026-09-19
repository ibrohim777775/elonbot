-- Keep legacy file IDs readable. New photos are referenced by messages in the owner's bot chat.
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS photo_message_ids jsonb NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(photo_message_ids)='array' AND jsonb_array_length(photo_message_ids)<=10);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS photo_message_ids jsonb NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(photo_message_ids)='array' AND jsonb_array_length(photo_message_ids)<=10);
