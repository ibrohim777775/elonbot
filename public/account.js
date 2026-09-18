"use strict";
const token = location.hash.slice(1);
const language = new URLSearchParams(location.search).get("lang") === "ru" ? "ru" : "uz";
const pick = (uz, ru) => language === "ru" ? ru : uz;
history.replaceState(null, "", location.pathname + location.search);
const form = document.getElementById("login");
const field = document.getElementById("value");
const label = document.getElementById("label");
const status = document.getElementById("status");
const button = document.getElementById("submit");
document.documentElement.lang = language;
document.title = pick("Elonbot — Telegram akkaunt", "Elonbot — Telegram-аккаунт");
document.querySelector("h1").textContent = pick("Telegram akkauntingizni ulang", "Подключите Telegram-аккаунт");
document.querySelector("h1 + p").textContent = pick("E'lonlar tanlagan guruhlaringizga o'z akkauntingizdan yuboriladi. Bot bilan yozishayotgan akkauntingizga kiring.", "Объявления будут отправляться в выбранные группы от вашего имени. Войдите в тот аккаунт, с которого вы общаетесь с ботом.");
document.querySelector(".note").textContent = pick("Ulangan sessiya shifrlangan holda saqlanadi. Kod va 2FA paroli saqlanmaydi. Botdagi «Sozlamalar» → «Telegram akkaunt» bo'limidan uzishingiz mumkin.", "Сессия хранится в зашифрованном виде. Код и пароль 2FA не сохраняются. Отключить аккаунт можно в разделе «Настройки» → «Telegram-аккаунт» в боте.");
label.textContent = pick("Telefon raqami", "Номер телефона");
button.textContent = pick("Davom etish", "Продолжить");
let action = "begin";
const errors = {
  PHONE_NUMBER_INVALID: pick("Telefon raqamini xalqaro formatda kiriting.", "Введите номер телефона в международном формате."),
  PHONE_CODE_INVALID: pick("Kod noto'g'ri. Qayta kiriting.", "Неверный код. Введите ещё раз."),
  PHONE_CODE_EXPIRED: pick("Kod eskirdi. Botdan yangi kirish havolasini oling.", "Код истёк. Получите новую ссылку для входа в боте."),
  PASSWORD_HASH_INVALID: pick("2FA paroli noto'g'ri. Qayta kiriting.", "Неверный пароль 2FA. Введите ещё раз."),
  ACCOUNT_MISMATCH: pick("Bot bilan yozishayotgan Telegram akkauntingizga kiring. Botdan yangi havola oling.", "Войдите в аккаунт, с которого общаетесь с ботом. Получите новую ссылку в боте."),
  LOGIN_EXPIRED: pick("Havola eskirgan. Botdan yangi kirish havolasini oling.", "Ссылка истекла. Получите новую ссылку для входа в боте."),
  LOGIN_ALREADY_STARTED: pick("Kirish boshlangan. Botdan yangi havola oling.", "Вход уже начат. Получите новую ссылку в боте."),
  EMAIL_LOGIN_UNSUPPORTED: pick("Telegram email tasdiqlashini talab qildi. Bu usul hozircha qo'llanmaydi.", "Telegram запросил подтверждение email. Этот способ пока не поддерживается."),
  EXISTING_ACCOUNT_REQUIRED: pick("Avval rasmiy Telegram ilovasida akkaunt yarating.", "Сначала создайте аккаунт в официальном приложении Telegram."),
  CAPTCHA_REQUIRED: pick("Telegram qo'shimcha CAPTCHA tekshiruvini talab qildi. Bu usul hozircha qo'llanmaydi.", "Telegram запросил дополнительную проверку CAPTCHA. Этот способ пока не поддерживается."),
};
if (!token) { form.hidden = true; status.textContent = errors.LOGIN_EXPIRED; }
form.addEventListener("submit", async event => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = pick("Kuting…", "Подождите…");
  const value = field.value;
  field.value = "";
  try {
    const response = await fetch("/account/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, action, value }), cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok) {
      status.textContent = result.seconds > 0 ? pick(`${result.seconds} soniyadan keyin qayta urinib ko'ring.`, `Повторите через ${result.seconds} сек.`) :
        errors[result.error] || pick("Ulanib bo'lmadi. Botdan yangi havola olib, qayta urinib ko'ring.", "Не удалось подключиться. Получите новую ссылку в боте и попробуйте ещё раз.");
      return;
    }
    if (result.stage === "done") {
      form.hidden = true;
      status.textContent = pick("Akkaunt ulandi. Botga qayting va Guruhlar bo'limida guruhlarni tanlang.", "Аккаунт подключён. Вернитесь в бот и выберите группы в разделе «Группы».");
      return;
    }
    action = result.stage;
    const password = action === "password";
    label.textContent = password ? pick("Telegram 2FA paroli", "Пароль Telegram 2FA") : pick("Telegram tasdiqlash kodi", "Код подтверждения Telegram");
    field.type = password ? "password" : "text";
    field.inputMode = password ? "text" : "numeric";
    field.autocomplete = password ? "current-password" : "one-time-code";
    field.placeholder = "";
    status.textContent = password ? pick("Ikki bosqichli himoya parolini kiriting.", "Введите пароль двухэтапной аутентификации.") : pick("Telegram yuborgan kodni shu sahifaga kiriting.", "Введите на этой странице код, который прислал Telegram.");
    field.focus();
  } catch { status.textContent = pick("Aloqa uzildi. Botdan yangi havola olib, qayta urinib ko'ring.", "Соединение прервалось. Получите новую ссылку в боте и попробуйте ещё раз."); }
  finally { button.disabled = false; }
});
