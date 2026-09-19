import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

class Element {
  textContent = ""; value = ""; hidden = false; disabled = false; type = "tel";
  inputMode = ""; autocomplete = "tel"; placeholder = "+998…";
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  handlers: Record<string, Function> = {};
  addEventListener(event: string, handler: Function) { this.handlers[event] = handler; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  focus() {}
}
const response = (body: any, ok = true) => ({ ok, async json() { return body; } });
async function page(url = `https://example.test/account#${"t".repeat(43)}`) {
  const elements = Object.fromEntries(["login", "value", "label", "status", "submit", "languages", "h1", "h1 + p", ".note"].map(key => [key, new Element()]));
  const toggles = ["uz", "ru"].map(language => { const e = new Element(); e.dataset.language = language; return e; });
  const document = { documentElement: { lang: "uz" }, title: "",
    getElementById: (id: string) => elements[id], querySelector: (selector: string) => elements[selector],
    querySelectorAll: () => toggles,
  };
  const location = new URL(url), historyUrls: string[] = [], requests: any[] = [], replies: any[] = [];
  runInNewContext(await readFile("public/account.js", "utf8"), {
    document, location, URLSearchParams, navigator: { language: "ru-RU" },
    history: { replaceState(_state: any, _title: string, value: string) { historyUrls.push(value); location.href = new URL(value, location).href; } },
    async fetch(path: string, options: any) { requests.push({ path, ...options, body: JSON.parse(options.body) }); return await replies.shift(); },
  });
  return { elements, document, location, historyUrls, requests, replies, toggles,
    select: (language: string) => toggles.find(e => e.dataset.language === language)!.handlers.click(),
    submit: () => elements.login.handlers.submit({ preventDefault() {} }),
  };
}

test("login defaults to Uzbek independently of browser language and can switch an expired page or a Russian bot link", async () => {
  const h = await page("https://example.test/account");
  assert.equal(h.document.documentElement.lang, "uz"); assert.equal(h.elements.login.hidden, true);
  assert.match(h.elements.status.textContent, /Havola eskirgan/);
  h.select("ru"); assert.match(h.elements.status.textContent, /Ссылка истекла/);
  assert.equal(h.elements.login.hidden, true); assert.equal(h.elements.languages.attributes["aria-label"], "Язык");
  assert.equal(h.toggles[1].attributes["aria-pressed"], "true"); assert.equal(h.requests.length, 0);
  const russian = await page(`https://example.test/account?lang=ru#${"t".repeat(43)}`);
  assert.equal(russian.document.documentElement.lang, "ru"); assert.equal(russian.elements.label.textContent, "Номер телефона");
  russian.select("uz"); assert.equal(russian.elements.label.textContent, "Telefon raqami");
});

test("switching languages preserves login token, phone, code and masked 2FA input through errors and success", async () => {
  const h = await page(), e = h.elements;
  assert.equal(h.document.documentElement.lang, "uz"); assert.equal(e.login.hidden, false);
  e.value.value = "+998901234567"; h.select("ru");
  assert.equal(e.value.value, "+998901234567"); assert.equal(e.label.textContent, "Номер телефона");
  h.replies.push(response({ stage: "code" })); await h.submit();
  assert.equal(e.label.textContent, "Код подтверждения Telegram");
  e.value.value = "12345"; h.select("uz");
  assert.equal(e.value.value, "12345"); assert.equal(e.value.autocomplete, "one-time-code");
  assert.equal(e.label.textContent, "Telegram tasdiqlash kodi");
  h.replies.push(response({ error: "PHONE_CODE_INVALID" }, false)); await h.submit();
  assert.match(e.status.textContent, /Kod noto'g'ri/);
  h.select("ru"); assert.match(e.status.textContent, /Неверный код/);
  e.value.value = "54321"; h.replies.push(response({ stage: "password" })); await h.submit();
  assert.equal(e.value.type, "password"); assert.equal(e.label.textContent, "Пароль Telegram 2FA");
  e.value.value = "private-2fa"; h.select("uz");
  assert.equal(e.value.type, "password"); assert.equal(e.value.value, "private-2fa");
  assert.equal(e.label.textContent, "Telegram 2FA paroli");
  h.replies.push(response({ stage: "done" })); await h.submit();
  assert.equal(e.login.hidden, true); assert.match(e.status.textContent, /Akkaunt ulandi/);
  h.select("ru"); assert.match(e.status.textContent, /Аккаунт подключён/); assert.equal(e.login.hidden, true);
  assert.deepEqual(h.requests.map(r => [r.body.action, r.body.value]), [["begin", "+998901234567"], ["code", "12345"], ["code", "54321"], ["password", "private-2fa"]]);
  assert.ok(h.requests.every(r => r.body.token === "t".repeat(43) && r.path === "/account/login" && r.cache === "no-store"));
  assert.doesNotMatch(h.historyUrls.join(" "), /#|ttttt|12345|54321|private-2fa/);
  assert.equal(e.value.value, "");
});

test("language toggles translate pending requests and rate-limit errors without duplicate login requests", async () => {
  const h = await page(), e = h.elements;
  let finish!: Function;
  h.replies.push(new Promise(resolve => { finish = resolve; }));
  e.value.value = "+998901234567"; const pending = h.submit();
  assert.equal(e.submit.disabled, true); assert.equal(e.status.textContent, "Kuting…");
  h.select("ru"); assert.equal(e.status.textContent, "Подождите…");
  await h.submit(); assert.equal(h.requests.length, 1);
  finish(response({ error: "FLOOD_WAIT", seconds: 35 }, false)); await pending;
  assert.equal(e.status.textContent, "Повторите через 35 сек."); assert.equal(e.submit.disabled, false);
  h.select("uz"); assert.equal(e.status.textContent, "35 soniyadan keyin qayta urinib ko'ring.");
  h.replies.push(Promise.reject(new Error("offline"))); await h.submit();
  assert.match(e.status.textContent, /Aloqa uzildi/);
  h.select("ru"); assert.match(e.status.textContent, /Соединение прервалось/);
});
