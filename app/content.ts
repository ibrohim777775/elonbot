import { HTMLParser } from "teleproto/extensions/html";

export function renderText(announcement: Record<string, any>) {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const parts = [escape(announcement.text)];
  if (announcement.contact_name) parts.push(`\n${escape(announcement.contact_name)}`);
  if (announcement.contact_phone) parts.push(`Tel: ${escape(announcement.contact_phone)}`);
  if (announcement.contact_telegram) {
    const contact = announcement.contact_telegram.trim();
    const match = /^(?:@|(?:https?:\/\/)?t\.me\/)?([A-Za-z0-9_]{4,32})\/?$/.exec(contact);
    parts.push(match ? `Telegram: <a href="https://t.me/${match[1]}">@${match[1]}</a>` : `Telegram: ${escape(contact)}`);
  }
  return parts.join("\n");
}
// Match the transport's parsed UTF-16 text, including contacts, rather than HTML markup.
export const messageLength = (record: Record<string, any>) => HTMLParser.parse(renderText(record))[0].length;
