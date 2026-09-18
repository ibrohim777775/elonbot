import { readFile } from "node:fs/promises";
import { languageOf } from "./i18n";

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

// The guide only uses headings, paragraphs and bullet lines. Treat all document text as text, never HTML.
export async function helpPage(requestedLanguage: unknown) {
  const language = languageOf(requestedLanguage);
  const [layout, document] = await Promise.all([
    readFile("public/help.html", "utf8"),
    readFile(`docs/${language === "ru" ? "rukovodstvo-ru" : "foydalanish-qollanmasi-uz"}.md`, "utf8"),
  ]);
  const sections: { id: string; title: string }[] = [];
  let title = "Elonbot";
  const article = document.trim().split(/\r?\n\s*\r?\n/).map(block => {
    const heading = /^\*\*([^\r\n]+)\*\*$/.exec(block);
    if (heading) {
      if (title === "Elonbot") { title = heading[1]; return `<h1>${escape(title)}</h1>`; }
      const id = `guide-step-${sections.length + 1}`;
      sections.push({ id, title: heading[1] });
      return `<h2 id="${id}">${escape(heading[1])}</h2>`;
    }
    const lines = block.split(/\r?\n/), bulletAt = lines.findIndex(line => line.startsWith("• "));
    if (bulletAt >= 0) return `${bulletAt ? `<p>${escape(lines.slice(0, bulletAt).join(" "))}</p>` : ""}<ul>${lines.slice(bulletAt).map(line => `<li>${escape(line.replace(/^• /, ""))}</li>`).join("")}</ul>`;
    return `<p>${escape(block.replace(/\r?\n/g, " "))}</p>`;
  }).join("\n");
  const values: Record<string, string> = {
    language, title: escape(title), article,
    help: language === "ru" ? "Помощь" : "Qo'llanma",
    contents: language === "ru" ? "Содержание" : "Mundarija",
    close: language === "ru" ? "Вернуться в бот" : "Botga qaytish",
    languages: language === "ru" ? "Язык инструкции" : "Qo'llanma tili",
    uzCurrent: language === "uz" ? 'aria-current="page"' : "",
    ruCurrent: language === "ru" ? 'aria-current="page"' : "",
    links: sections.map(section => `<a href="#${section.id}">${escape(section.title)}</a>`).join(""),
  };
  return layout.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? "");
}
