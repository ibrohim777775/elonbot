(() => {
  "use strict";
  const tg = window.Telegram?.WebApp;
  const screen = document.querySelector("#screen");
  const footer = document.querySelector("#footer");
  const toast = document.querySelector("#toast");
  const helpScreen = document.querySelector("#help-screen");
  let helpLanguage, helpRequest = 0;
  const state = { connected: [], groups: [], limit: 20, query: "", shown: 40, loading: false, adding: null, retryAt: 0, loaded: false };
  let language = tg?.initDataUnsafe?.user?.language_code?.startsWith("ru") ? "ru" : "uz";
  const pick = (uz, ru) => language === "ru" ? ru : uz;
  function localizeChrome() {
    document.documentElement.lang = language;
    document.title = `Elonbot — ${pick("Guruh qo'shish", "Добавить группу")}`;
    document.querySelector(".connection").textContent = pick("Guruh qo'shish", "Добавить группу");
    document.querySelector('[data-action="close"]').textContent = pick("Botga qaytish", "Вернуться в бот");
    toast.querySelector("button").setAttribute("aria-label", pick("Yopish", "Закрыть"));
    document.querySelector('[data-view="groups"]').textContent = pick("Guruhlar", "Группы");
    const helpLink = document.querySelector('[data-view="help"]');
    helpLink.textContent = pick("Qo'llanma", "Помощь"); helpLink.href = `/help?lang=${language}`;
    if (document.body.classList.contains("help-open")) void openHelp();
  }
  function showGroups() {
    document.body.classList.remove("help-open"); helpScreen.hidden = true;
    document.title = `Elonbot — ${pick("Guruh qo'shish", "Добавить группу")}`;
    document.querySelector(".connection").textContent = pick("Guruh qo'shish", "Добавить группу");
    document.querySelector('[data-view="groups"]').setAttribute("aria-current", "page");
    document.querySelector('[data-view="help"]').removeAttribute("aria-current");
    document.querySelector('[data-view="groups"]').focus();
  }
  async function openHelp() {
    document.body.classList.add("help-open"); helpScreen.hidden = false;
    document.title = `Elonbot — ${pick("Qo'llanma", "Помощь")}`;
    document.querySelector(".connection").textContent = pick("Qo'llanma", "Помощь");
    document.querySelector('[data-view="help"]').setAttribute("aria-current", "page");
    document.querySelector('[data-view="groups"]').removeAttribute("aria-current");
    if (helpLanguage === language) { helpScreen.focus({ preventScroll: true }); return; }
    const requestedLanguage = language, request = ++helpRequest;
    helpScreen.textContent = pick("Qo'llanma yuklanmoqda…", "Загружаем инструкцию…");
    helpScreen.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(`/help?lang=${requestedLanguage}`, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("Help unavailable");
      const guide = new DOMParser().parseFromString(await response.text(), "text/html").querySelector("#guide");
      if (!guide) throw new Error("Help content missing");
      if (request !== helpRequest) return;
      helpScreen.replaceChildren(...guide.childNodes); helpLanguage = requestedLanguage;
      if (!helpScreen.hidden) helpScreen.focus({ preventScroll: true });
    } catch {
      if (request !== helpRequest) return;
      helpScreen.innerHTML = `<p>${pick("Qo'llanmani yuklab bo'lmadi. Internetni tekshirib, qayta urinib ko'ring.", "Не удалось загрузить инструкцию. Проверьте интернет и повторите.")}</p><button type="button" class="primary" data-action="help">${pick("Qayta urinish", "Повторить")}</button>`;
    } finally { if (request === helpRequest) helpScreen.removeAttribute("aria-busy"); }
  }
  let toastTimer;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function notify(message) {
    clearTimeout(toastTimer); toast.querySelector("span").textContent = message; toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
  }
  toast.querySelector("button").addEventListener("click", () => { toast.hidden = true; });
  function errorText(error) {
    const messages = {
      UNAUTHORIZED: pick("Ilovani botdagi tugma orqali qayta oching.", "Откройте приложение заново кнопкой в боте."), AUTH_EXPIRED: pick("Seans tugadi. Ilovani botdan qayta oching.", "Сеанс истёк. Откройте приложение заново из бота."),
      LOGIN_REQUIRED: pick("Avval botdagi «Sozlamalar» → «Telegram akkaunt» bo'limida akkauntingizni ulang.", "Сначала подключите аккаунт в разделе «Настройки» → «Telegram-аккаунт» в боте."),
      AUTH_KEY_UNREGISTERED: pick("Telegram seansi tugadi. Bot orqali akkauntingizni qayta ulang.", "Сессия Telegram завершена. Подключите аккаунт заново через бот."),
      SESSION_REVOKED: pick("Telegram seansi tugadi. Bot orqali akkauntingizni qayta ulang.", "Сессия Telegram завершена. Подключите аккаунт заново через бот."),
      CHAT_WRITE_FORBIDDEN: pick("Bu guruhga xabar yuborish huquqingiz yo'q.", "У вас нет права отправлять сообщения в эту группу."), GROUP_LIMIT: pick(`Eng ko'pi ${state.limit} ta guruh ulash mumkin. Guruhni o'chirish uchun botga qayting.`, `Можно подключить не больше ${state.limit} групп. Для удаления группы вернитесь в бот.`),
      NOT_FOUND: pick("Guruh topilmadi. Ro'yxatni yangilang.", "Группа не найдена. Обновите список."), STARTING: pick("Server ishga tushmoqda. Birozdan so'ng qayta urinib ko'ring.", "Сервер запускается. Повторите немного позже."),
      NETWORK_ERROR: pick("Server bilan aloqa yo'q. Internetni tekshirib, qayta urinib ko'ring.", "Нет связи с сервером. Проверьте интернет и попробуйте снова."),
    };
    if (error.seconds) return pick(`Telegram ro'yxatni yangilashni vaqtincha chekladi. ${error.seconds} soniyadan so'ng qayta urinib ko'ring.`, `Telegram временно ограничил обновление списка. Повторите через ${error.seconds} сек.`);
    return messages[error.code] || pick("Guruhlarni yuklab bo'lmadi. Qayta urinib ko'ring.", "Не удалось загрузить группы. Попробуйте ещё раз.");
  }
  async function api(path, data) {
    let response;
    try {
      response = await fetch(path, { method: data === undefined ? "GET" : "POST", headers: {
        Authorization: `tma ${tg?.initData || ""}`, ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(120000) });
    } catch { throw { code: "NETWORK_ERROR" }; }
    let result;
    try { result = await response.json(); } catch { throw { code: "NETWORK_ERROR" }; }
    if (!response.ok) throw { code: result.error, seconds: result.seconds };
    return result;
  }
  function close() {
    if (tg?.initData) tg.close();
    else notify(pick("Botga qayting va «Botda davom etish» tugmasini bosing.", "Вернитесь в бот и нажмите «Продолжить в боте»."));
  }
  function gate(title, description, retry = false) {
    screen.innerHTML = `<section class="empty"><span class="empty-icon" aria-hidden="true">↗</span><h1>${escape(title)}</h1><p>${escape(description)}</p>${retry ? `<button class="primary" data-action="start">${pick("Qayta urinish", "Повторить")}</button>` : ""}</section>`;
  }
  function render() {
    screen.innerHTML = `<section class="intro"><p class="eyebrow">${pick("TELEGRAM GURUHLARINGIZ", "ВАШИ ГРУППЫ TELEGRAM")}</p><h1>${pick("Guruh qo'shish", "Добавить группу")}</h1><p>${pick("E'lon yuboriladigan guruhlarni ulang.<br>E'lonlar va sozlamalar botda qoladi.", "Подключите группы для отправки объявлений.<br>Объявления и настройки доступны в боте.")}</p></section>
      <section class="panel"><div class="panel-heading"><h2>${pick("Guruhlaringiz", "Ваши группы")}</h2><button class="refresh" data-action="refresh">${pick("Ro'yxatni yangilash", "Обновить список")}</button></div>
      <label class="search"><span aria-hidden="true">⌕</span><input type="search" placeholder="${pick("Guruh nomini qidirish", "Поиск группы по названию")}" aria-label="${pick("Guruh nomini qidirish", "Поиск группы по названию")}" autocomplete="off" value="${escape(state.query)}"></label>
      <p class="notice" id="notice" role="status"></p><div id="group-list"></div><button class="more" data-action="more" hidden>${pick("Ko'proq ko'rsatish", "Показать ещё")}</button></section>
      <p class="hint">${pick("Faqat o'zingiz a'zo bo'lgan guruhlar ko'rinadi. Botni guruhga qo'shish shart emas.", "Показаны группы, в которых вы состоите. Добавлять бота в группу не нужно.")}</p>`;
    footer.hidden = false;
    renderList(); updateStatus();
  }
  function renderList() {
    const list = document.querySelector("#group-list"); if (!list) return;
    const connected = new Set(state.connected.map(g => g.chatId));
    const query = state.query.trim().toLocaleLowerCase();
    const filtered = state.groups.filter(g => g.title.toLocaleLowerCase().includes(query));
    list.innerHTML = filtered.slice(0, state.shown).map(g => {
      const joined = connected.has(g.chatId), adding = state.adding === g.chatId;
      const initials = Array.from(g.title.trim())[0] || "G";
      return `<article class="group"><span class="avatar" aria-hidden="true">${escape(initials.toLocaleUpperCase())}</span><div class="group-info"><h3>${escape(g.title)}</h3><p>${joined ? pick("Ulangan", "Подключена") : g.canPost ? pick("Xabar yuborish mumkin", "Можно отправлять сообщения") : pick("Yozish huquqi yo'q", "Нет права отправки")}</p></div><button class="connect ${joined ? "joined" : ""}" data-chat="${escape(g.chatId)}" aria-label="${escape(g.title)} — ${joined ? pick("Ulangan", "Подключена") : pick("Ulash", "Подключить")}" ${joined || !g.canPost || state.adding !== null ? "disabled" : ""}>${adding ? pick("Ulanmoqda…", "Подключаем…") : joined ? pick("✓ Ulangan", "✓ Подключена") : pick("Ulash", "Подключить")}</button></article>`;
    }).join("") || `<div class="list-empty">${state.loading ? `<span class="loader" aria-hidden="true"></span><p>${pick("Guruhlar yuklanmoqda…", "Загружаем группы…")}</p>` : query ? pick("Bu nom bilan guruh topilmadi.", "Группа с таким названием не найдена.") : state.loaded ? pick("Hozircha guruhlar topilmadi.", "Пока нет доступных групп.") : pick("Ro'yxatni yuklash uchun qayta urinib ko'ring.", "Попробуйте загрузить список ещё раз.")}</div>`;
    document.querySelector('[data-action="more"]').hidden = filtered.length <= state.shown;
    document.querySelector("#connected-count").textContent = pick(`${state.connected.length} / ${state.limit} guruh ulangan`, `Подключено: ${state.connected.length} / ${state.limit}`);
  }
  function updateStatus() {
    const refresh = document.querySelector('[data-action="refresh"]'), notice = document.querySelector("#notice");
    if (!refresh || !notice) return;
    const seconds = Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000));
    refresh.disabled = state.loading || seconds > 0 || state.adding !== null;
    refresh.textContent = state.loading ? pick("Yuklanmoqda…", "Загрузка…") : seconds ? pick(`Yangilash (${seconds}s)`, `Обновить (${seconds} с)`) : pick("Ro'yxatni yangilash", "Обновить список");
    notice.textContent = seconds ? pick(`Telegram cheklovi: yangilash ${seconds} soniyadan so'ng. Saqlangan guruhlarni ulashingiz mumkin.`, `Ограничение Telegram: обновление через ${seconds} сек. Сохранённые группы можно подключать.`) : state.loading ? pick("Telegram'dan ro'yxat olinmoqda. Bu biroz vaqt olishi mumkin.", "Получаем список из Telegram. Это может занять некоторое время.") : state.error || "";
    notice.hidden = !notice.textContent;
  }
  async function discover(refresh = false) {
    if (state.loading || state.adding) return;
    state.loading = true; state.error = ""; updateStatus(); renderList();
    try {
      const result = await api("/api/groups/discover", { refresh });
      state.groups = result.groups; state.loaded = true; state.retryAt = result.retryAt ? new Date(result.retryAt).getTime() : 0;
    } catch (error) {
      if (error.seconds) state.retryAt = Date.now() + error.seconds * 1000;
      state.error = errorText(error); notify(state.error);
    } finally { state.loading = false; renderList(); updateStatus(); }
  }
  async function connect(chatId) {
    if (state.adding) return;
    state.adding = chatId; renderList(); updateStatus();
    try {
      const result = await api("/api/groups/connect", { chatId });
      if (!state.connected.some(g => g.chatId === chatId)) state.connected.push(result.group);
      tg?.HapticFeedback?.notificationOccurred("success"); notify(pick("Guruh ulandi. Endi botda e'lon uchun tanlashingiz mumkin.", "Группа подключена. Теперь её можно выбрать для объявления в боте."));
    } catch (error) { notify(errorText(error)); }
    finally { state.adding = null; renderList(); updateStatus(); }
  }
  async function start() {
    localizeChrome();
    if (!tg?.initData) { gate(pick("Telegram orqali oching", "Откройте через Telegram"), pick("Botdagi «Guruh qo'shish» tugmasini bosing yoki /app buyrug'ini yuboring.", "Нажмите «Добавить группу» в боте или отправьте команду /app.")); return; }
    try {
      const result = await api("/api/state");
      language = result.language === "ru" ? "ru" : "uz"; localizeChrome();
      state.connected = result.connected; state.limit = result.limit;
      footer.hidden = false; document.querySelector("#connected-count").textContent = pick(`${state.connected.length} / ${state.limit} guruh ulangan`, `Подключено: ${state.connected.length} / ${state.limit}`);
      if (!result.accountConnected) { gate(pick("Avval akkauntni ulang", "Сначала подключите аккаунт"), pick("Botga qayting: «Sozlamalar» → «Telegram akkaunt» → «Akkauntni ulash». Shundan so'ng guruhlarni qo'shishingiz mumkin.", "Вернитесь в бот: «Настройки» → «Telegram-аккаунт» → «Подключить аккаунт». После этого можно добавить группы.")); return; }
      render(); await discover();
    } catch (error) { gate(pick("Guruhlar ochilmadi", "Не удалось открыть группы"), errorText(error), true); }
  }
  screen.addEventListener("input", event => {
    if (event.target.matches('input[type="search"]')) { state.query = event.target.value; state.shown = 40; renderList(); }
  });
  document.addEventListener("click", event => {
    const navigation = event.target.closest("a[data-view]");
    if (navigation && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (navigation.dataset.view === "help") void openHelp(); else showGroups();
      return;
    }
    const button = event.target.closest("button"); if (!button || button.disabled) return;
    if (button.dataset.chat) { void connect(button.dataset.chat); return; }
    switch (button.dataset.action) {
      case "close": close(); break;
      case "help": void openHelp(); break;
      case "refresh": void discover(true); break;
      case "start": void start(); break;
      case "more": state.shown += 40; renderList(); break;
    }
  });
  if (tg?.initData) { tg.ready(); tg.expand(); tg.BackButton?.show(); tg.BackButton?.onClick(() => document.body.classList.contains("help-open") ? showGroups() : close()); }
  setInterval(updateStatus, 1000); // Local countdown only; never polls Telegram.
  void start();
})();
