import { Language, t } from "./i18n";

export function botCommands(language: Language, admin = false) {
  const commands = [
    { command: "boshlash", description: t("commands.boshlash", {}, language) },
    { command: "settings", description: t("menu.settings", {}, language) },
    { command: "help", description: t("menu.help", {}, language) },
    { command: "app", description: t("app.open", {}, language) },
    { command: "support", description: t("menu.support", {}, language) },
    { command: "guruh_ulash", description: t("commands.guruh_ulash", {}, language) },
    { command: "statistika", description: t("commands.statistika", {}, language) },
  ];
  if (admin) commands.splice(2, 0, { command: "admin", description: t("admin.title", {}, language) });
  return commands;
}
