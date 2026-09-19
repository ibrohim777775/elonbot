export const maxAnnouncementPhotos = 10;

// Legacy records remain readable; new records only reference messages in the bot chat.
export function photosOf(record: Record<string, any>): string[] {
  return record.photo_file_ids?.length ? record.photo_file_ids : record.photo_file_id ? [record.photo_file_id] : [];
}
export function photoMessageIds(record: Record<string, any>): number[] {
  return record.photo_message_ids ?? [];
}
export function photoCount(record: Record<string, any>): number {
  return photoMessageIds(record).length || photosOf(record).length;
}
