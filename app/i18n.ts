import { AsyncLocalStorage } from "node:async_hooks";
import uz from "./uz.json";
import ru from "./ru.json";
export type Language = "uz" | "ru";
export const languages: Language[] = ["uz", "ru"];
export const languageOf = (value: unknown): Language => typeof value === "string" && /^ru(?:-|$)/i.test(value) ? "ru" : "uz";
// Each update owns its language context, including awaits and error handlers.
const context = new AsyncLocalStorage<{ language: Language }>();
export const currentLanguage = () => context.getStore()?.language ?? "uz";
export function withLanguage<T>(language: Language, fn: () => T): T { return context.run({ language }, fn); }
export function changeLanguage(language: Language) {
  const active = context.getStore();
  if (!active) throw new Error("Language context is missing");
  active.language = language;
}
export const translations = (key: string) => [...new Set(languages.map(language => t(key, {}, language)))];
export function t(key: string, values: Record<string, string | number> = {}, language = currentLanguage()): string {
  let result: any = language === "ru" ? ru : uz;
  for (const segment of key.split(".")) result = result?.[segment];
  if (typeof result !== "string") throw new Error(`Missing translation: ${key}`);
  return result.replace(/\{(\w+)\}/g, (_: string, name: string) => String(values[name] ?? `{${name}}`));
}
