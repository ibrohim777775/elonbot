"use strict";
const token = location.hash.slice(1);
let language = new URLSearchParams(location.search).get("lang") === "ru" ? "ru" : "uz";
const pick = (uz, ru) => language === "ru" ? ru : uz;
history.replaceState(null, "", location.pathname + location.search);
const form = document.getElementById("login");
const field = document.getElementById("value");
const label = document.getElementById("label");
const status = document.getElementById("status");
const button = document.getElementById("submit");
const languageButtons = document.querySelectorAll("[data-language]");
let action = "begin", pending = false, statusKey = token ? "" : "LOGIN_EXPIRED", retryAfter = 0;

const messages = {
  title: ["Elonbot — Telegram akkaunt", "Elonbot — Telegram-аккаунт"],
  heading: ["Telegram akkauntingizni ulang", "Подключите Telegram-аккаунт"],
  description: ["E'lonlar tanlagan guruhlaringizga o'z akkauntingizdan yuboriladi. Bot bilan yozishayotgan akkauntingizga kiring. Elonbot boshqa chatlardagi yozishmalaringiz tarixini saqlamaydi va ulardagi yangi xabarlarni kuzatmaydi.", "Объявления будут отправляться в выбранные группы от вашего имени. Войдите в тот аккаунт, с которого вы общаетесь с ботом. Elonbot не сохраняет историю ваших переписок в других чатах и не отслеживает новые сообщения в них."],
  note: ["Xizmat ishlashi uchun shifrlangan ulanish sessiyasi, profil va guruh ma'lumotlari, e'lonlar, qoralamalar, shablonlar, sozlamalar, yuborish natijalari va yordam uchun murojaatlar saqlanadi. Botga o'zingiz yuborgan xabarlar e'lon yoki yordam uchun qayta ishlanadi. Kirish kodi va 2FA paroli saqlanmaydi. Ulanish sessiyasining ruxsatlari faqat tanlangan guruhlar bilan cheklanmaydi. Botdagi «Sozlamalar» → «Telegram akkaunt» orqali uzishingiz yoki Telegram → Sozlamalar → Qurilmalar bo'limida Elonbot sessiyasini tugatishingiz mumkin.", "Для работы сервиса сохраняются зашифрованная сессия подключения, данные профиля и групп, объявления, черновики, шаблоны, настройки, результаты отправки и обращения в поддержку. Сообщения, которые вы сами отправляете боту, обрабатываются для объявлений или поддержки. Код входа и пароль 2FA не сохраняются. Права сессии не ограничены выбранными группами. Отключить аккаунт можно в боте: «Настройки» → «Telegram-аккаунт», или завершить сессию Elonbot в Telegram → Настройки → Устройства."],
  begin: ["Telefon raqami", "Номер телефона"],
  code: ["Telegram tasdiqlash kodi", "Код подтверждения Telegram"],
  password: ["Telegram 2FA paroli", "Пароль Telegram 2FA"],
  continue: ["Davom etish", "Продолжить"],
  languages: ["Til", "Язык"],
  waiting: ["Kuting…", "Подождите…"],
  code_hint: ["Telegram yuborgan kodni shu sahifaga kiriting.", "Введите на этой странице код, который прислал Telegram."],
  password_hint: ["Ikki bosqichli himoya parolini kiriting.", "Введите пароль двухэтапной аутентификации."],
  done: ["Akkaunt ulandi. Botga qayting va Guruhlar bo'limida guruhlarni tanlang.", "Аккаунт подключён. Вернитесь в бот и выберите группы в разделе «Группы»."],
  network: ["Aloqa uzildi. Botdan yangi havola olib, qayta urinib ko'ring.", "Соединение прервалось. Получите новую ссылку в боте и попробуйте ещё раз."],
  failure: ["Ulanib bo'lmadi. Botdan yangi havola olib, qayta urinib ko'ring.", "Не удалось подключиться. Получите новую ссылку в боте и попробуйте ещё раз."],
  PHONE_NUMBER_INVALID: ["Telefon raqamini xalqaro formatda kiriting.", "Введите номер телефона в международном формате."],
  PHONE_CODE_INVALID: ["Kod noto'g'ri. Qayta kiriting.", "Неверный код. Введите ещё раз."],
  PHONE_CODE_EXPIRED: ["Kod eskirdi. Botdan yangi kirish havolasini oling.", "Код истёк. Получите новую ссылку для входа в боте."],
  PASSWORD_HASH_INVALID: ["2FA paroli noto'g'ri. Qayta kiriting.", "Неверный пароль 2FA. Введите ещё раз."],
  ACCOUNT_MISMATCH: ["Bot bilan yozishayotgan Telegram akkauntingizga kiring. Botdan yangi havola oling.", "Войдите в аккаунт, с которого общаетесь с ботом. Получите новую ссылку в боте."],
  LOGIN_EXPIRED: ["Havola eskirgan. Botdan yangi kirish havolasini oling.", "Ссылка истекла. Получите новую ссылку для входа в боте."],
  LOGIN_ALREADY_STARTED: ["Kirish boshlangan. Botdan yangi havola oling.", "Вход уже начат. Получите новую ссылку в боте."],
  LOGIN_CAPACITY_REACHED: ["Hozir ko'p foydalanuvchi kirmoqda. Birozdan keyin qayta urinib ko'ring.", "Сейчас много подключений. Попробуйте войти немного позже."],
  EMAIL_LOGIN_UNSUPPORTED: ["Telegram email tasdiqlashini talab qildi. Bu usul hozircha qo'llanmaydi.", "Telegram запросил подтверждение email. Этот способ пока не поддерживается."],
  EXISTING_ACCOUNT_REQUIRED: ["Avval rasmiy Telegram ilovasida akkaunt yarating.", "Сначала создайте аккаунт в официальном приложении Telegram."],
  CAPTCHA_REQUIRED: ["Telegram qo'shimcha CAPTCHA tekshiruvini talab qildi. Bu usul hozircha qo'llanmaydi.", "Telegram запросил дополнительную проверку CAPTCHA. Этот способ пока не поддерживается."],
};
const text = key => pick(...(Object.hasOwn(messages, key) ? messages[key] : messages.failure));

function render() {
  document.documentElement.lang = language;
  document.title = text("title");
  document.querySelector("h1").textContent = text("heading");
  document.querySelector("h1 + p").textContent = text("description");
  document.querySelector(".note").textContent = text("note");
  document.getElementById("languages").setAttribute("aria-label", text("languages"));
  for (const toggle of languageButtons) toggle.setAttribute("aria-pressed", String(toggle.dataset.language === language));
  label.textContent = text(action === "done" ? "begin" : action);
  button.textContent = text("continue");
  button.disabled = pending;
  form.hidden = !token || action === "done";
  status.textContent = retryAfter > 0
    ? pick(`${retryAfter} soniyadan keyin qayta urinib ko'ring.`, `Повторите через ${retryAfter} сек.`)
    : statusKey ? text(statusKey) : "";
}

for (const toggle of languageButtons) toggle.addEventListener("click", () => {
  language = toggle.dataset.language === "ru" ? "ru" : "uz";
  const query = new URLSearchParams(location.search);
  query.set("lang", language);
  // Keep the login token in memory and preserve the current step and typed value.
  history.replaceState(null, "", `${location.pathname}?${query}`);
  render();
});
render();

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (pending || form.hidden) return;
  pending = true; statusKey = "waiting"; retryAfter = 0;
  render();
  const value = field.value;
  field.value = "";
  try {
    const response = await fetch("/account/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, action, value }), cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok) {
      retryAfter = Number.isFinite(result.seconds) && result.seconds > 0 ? Math.ceil(result.seconds) : 0;
      statusKey = result.error || "failure";
      return;
    }
    if (!["code", "password", "done"].includes(result.stage)) { statusKey = "failure"; return; }
    action = result.stage;
    if (action === "done") { statusKey = "done"; return; }
    const password = action === "password";
    field.type = password ? "password" : "text";
    field.inputMode = password ? "text" : "numeric";
    field.autocomplete = password ? "current-password" : "one-time-code";
    field.placeholder = "";
    statusKey = password ? "password_hint" : "code_hint";
    field.focus();
  } catch { statusKey = "network"; }
  finally { pending = false; render(); }
});
