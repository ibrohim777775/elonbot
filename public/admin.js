"use strict";
const $ = s => document.querySelector(s);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = value => value ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Tashkent", dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
const num = value => Number(value || 0).toLocaleString("ru-RU");
const names = { paid: "Оплачен", trial: "Пробный", expired: "Истёк", not_started: "Ещё не начат", sent: "Отправлено", failed: "Ошибка", unknown: "Не подтверждено", sending: "Отправляется", received: "Получено", active: "Активно", paused: "Приостановлено", deleted: "Удалено", rate_limited: "Ожидает повтора", skipped: "Пропущено", activate: "Активация", revoke: "Отключение", in: "Пользователь", out: "Администратор", photo: "Фото", document: "Документ", voice: "Голосовое", audio: "Аудио", video: "Видео", immediate: "Сразу", scheduled: "По расписанию" };
const badge = status => `<span class="badge ${esc(status)}">${esc(names[status] || status)}</span>`;
const yes = value => value ? "Да" : "Нет";
const dl = pairs => `<dl class="data">${pairs.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value ?? "—")}</dd>`).join("")}</dl>`;
const minute = v => `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
const windowText = r => r.send_start_minute == null ? "Круглосуточно" : `${minute(r.send_start_minute)}–${minute(r.send_end_minute)}${r.send_start_minute > r.send_end_minute ? " (через полночь)" : ""}`;
const tabNames = { profile: "Профиль", announcements: "Объявления", groups: "Группы", templates: "Шаблоны", deliveries: "Отправки", tariffs: "Тарифы", messages: "Переписка", notifications: "Ответы в группах" };
let tg, auth, authorized = false, browserLink, route = {}, generation = 0, currentUser, pendingTariff, mutation = false;
const drafts = new Map(), blobs = new Set(), pendingReplies = new Map(), pendingTariffs = new Map();
const errors = { UNAUTHORIZED: "Откройте админку командой /admin в Telegram-боте.", AUTH_EXPIRED: "Вход истёк. Закройте админку и откройте её заново командой /admin.", FORBIDDEN: "Нет доступа. Ваш Telegram ID должен быть указан в ADMIN_IDS.", INVALID_ORIGIN: "Адрес страницы не совпадает с BASE_URL сервера.", RATE_LIMITED: "Слишком много запросов. Подождите минуту.", NOT_FOUND: "Запись не найдена. Обновите список.", CONFLICT: "Этот запрос уже использован с другими данными. Обновите страницу.", INVALID_TEXT: "Введите текст ответа от 1 до 3500 символов.", FILE_TOO_LARGE: "Вложение превышает лимит загрузки 20 МБ.", FILE_UNAVAILABLE: "Telegram пока не отдал вложение. Попробуйте позже." };
function notice(text, error = false) { $("#notice").textContent = text; $("#notice").className = error ? "error" : ""; $("#notice").hidden = !text; }
async function api(path, payload, binary = false) {
  let response;
  try { response = await fetch(`/admin-api${path}`, { method: payload === undefined ? "GET" : "POST", credentials: "same-origin", headers: { ...(auth ? { Authorization: `tma ${auth}` } : {}), "X-Admin-Request": "1", ...(payload === undefined ? {} : { "Content-Type": "application/json" }) }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(45000) }); }
  catch { throw new Error("Связь с сервером прервалась. Обновите данные или повторите тот же запрос."); }
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(errors[result.error] || `Не удалось выполнить запрос (${response.status}). Попробуйте ещё раз.`); }
  return binary ? response.blob() : response.json();
}
Object.assign(errors, { INVALID_TEXT: "Заполните текст (до 3500 символов). Для рассылки нужны обе языковые версии.", NO_RECIPIENTS: "Нет получателей для рассылки.", TEMPLATE_NAME_USED: "Шаблон с таким названием уже существует. Укажите другое название.", PREVIEW_EXPIRED: "Предпросмотр старше 24 часов. Создайте новую рассылку и проверьте получателей." });
const broadcasts = new BroadcastView({ api, esc, fmt, num, notice, reload: () => load(), busy: value => { mutation = value; } });
function href(values) { return `#${new URLSearchParams(values)}`; }
function userLink(u, tab = "profile") { return href({ user: u.id, tab }); }
function pager(data) {
  const max = Math.max(1, Math.ceil(data.total / 20));
  return `<div class="pager"><button class="secondary" data-page="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>← Назад</button><span>${data.page} / ${max} · ${num(data.total)}</span><button class="secondary" data-page="${data.page + 1}" ${data.page >= max ? "disabled" : ""}>Далее →</button></div>`;
}
function media(kind, id, count, name) {
  return `<div class="media-list">${Array.from({ length: count }, (_, i) => `<div class="media-item"><button class="secondary" data-file="${kind}/${esc(id)}/${i}" data-name="${esc(name || `photo-${i + 1}.jpg`)}">${esc(name || `Фото ${i + 1}`)}</button></div>`).join("")}</div>`;
}
function overview(data) {
  const metrics = [["Пользователи", data.users], ["Платный тариф", data.paid], ["Пробный период", data.trial], ["Непрочитанные", data.unread], ["Отправлено сегодня", data.sent_today], ["Ошибки сегодня", data.failed_today], ["Объявления", data.announcements], ["Группы", data.groups]];
  return `<div class="metrics">${metrics.map(([label, value], i) => `<div class="metric ${i === 0 ? "accent" : ""}"><p>${label}</p><strong>${num(value)}</strong></div>`).join("")}</div><div class="grid-two"><section class="panel"><p class="eyebrow">ПОДПИСКА</p><h2>7 дней бесплатно</h2><p class="subtle">С создания первого объявления. Затем 20 000 сум за 30 дней — активация вручную администратором.</p>${dl([["Истёк доступ", data.expired], ["Сумма активаций", `${num(data.activations_sum)} сум`]])}<p class="subtle">Сумма ручных активаций; автоматического списания нет.</p><a href="#view=users">Управлять тарифами →</a></section><section class="panel"><p class="eyebrow">СЕРВИС</p><h2>Аккаунты и данные</h2>${dl([["Подключено аккаунтов", data.accounts], ["Сохранено шаблонов", data.templates], ["Без первого объявления", data.users - data.paid - data.trial - data.expired]])}<p class="subtle">В карточке пользователя доступны его объявления, группы, расписание, история отправок и обращения.</p><a href="#view=inbox">Открыть обращения →</a></section></div>`;
}
function users(data) {
  return `<form id="search-form" class="filters"><label>Поиск<input name="search" type="search" placeholder="Имя, @username или Telegram ID" value="${esc(route.search)}"></label><label>Тариф<select name="status"><option value="">Все пользователи</option>${["paid", "trial", "expired", "not_started"].map(s => `<option value="${s}" ${route.status === s ? "selected" : ""}>${names[s]}</option>`).join("")}</select></label><button type="submit">Найти</button></form>${data.rows.length ? `<div class="table-wrap"><table><thead><tr><th>Пользователь</th><th>Тариф</th><th class="extra">Аккаунт</th><th class="extra">Объявления / группы</th><th>Активность</th></tr></thead><tbody>${data.rows.map(u => `<tr><td><a class="user-link" href="${userLink(u)}">${esc(u.first_name || "Без имени")}</a><small>${u.username ? `@${esc(u.username)} · ` : ""}${esc(u.telegram_id)}</small>${u.unread ? `<a href="${userLink(u, "messages")}">${u.unread} новых сообщений</a>` : ""}</td><td>${badge(u.plan_status)}<small>${fmt(u.plan_status === "paid" ? u.paid_until : u.trial_ends_at)}</small></td><td class="extra">${u.connected ? "Подключён" : "Не подключён"}</td><td class="extra">${u.announcements} / ${u.groups}</td><td>${fmt(u.last_activity_at)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="panel empty">Пользователи не найдены. Попробуйте изменить поиск.</div>`}${pager(data)}`;
}
function inbox(data) {
  return `<p class="subtle">Сообщения поступают из кнопки «Связаться с админом» в боте. Ответ отправляется пользователю через бот.</p>${data.rows.length ? data.rows.map(u => `<a class="inbox-item" href="${userLink(u, "messages")}"><div class="row"><strong>${esc(u.first_name || "Без имени")} ${u.unread ? `<span class="badge trial">${u.unread} новых</span>` : ""}</strong><span class="subtle">${fmt(u.created_at)}</span></div><p>${u.direction === "out" ? "Вы: " : ""}${esc((u.text || names[u.kind] || "Вложение").slice(0, 180))}</p><small class="subtle">ID ${esc(u.telegram_id)} ${u.username ? `· @${esc(u.username)}` : ""}</small></a>`).join("") : `<div class="panel empty">Пока нет обращений.</div>`}${pager(data)}`;
}
function profileShell(data) {
  const u = data.user;
  return `<a class="back" href="#view=users">← Все пользователи</a><section class="panel"><div class="row"><div><h2 class="profile-name">${esc(u.first_name || "Без имени")}</h2><p class="profile-id subtle">${u.username ? `@${esc(u.username)} · ` : ""}Telegram ID ${esc(u.telegram_id)}</p></div>${badge(data.plan.status)}</div><div class="actions"><button data-tariff="activate">${data.plan.status === "paid" ? "Продлить" : "Включить"} · 20 000 сум / 30 дней</button>${u.paid_until && new Date(u.paid_until) > new Date() ? `<button class="secondary" data-tariff="revoke">Отключить платный тариф</button>` : ""}</div></section><nav class="tabs" aria-label="Данные пользователя">${Object.entries(tabNames).map(([tab, title]) => `<a class="${route.tab === tab ? "active" : ""}" href="${userLink(u, tab)}">${title}</a>`).join("")}</nav><div id="user-content"></div>`;
}
function profile(data) {
  const u = data.user, a = data.account;
  return `<div class="grid-two"><section class="panel"><h3>Профиль и тариф</h3>${dl([["ID в системе", u.id], ["Регистрация", fmt(u.created_at)], ["Последняя активность", fmt(u.last_activity_at)], ["Пробный срок с", fmt(u.trial_started_at)], ["Пробный срок до", fmt(u.trial_ends_at)], ["Оплачен до", fmt(u.paid_until)], ["Доступ к рассылке", data.plan.allowed ? `До ${fmt(data.plan.until)}` : data.plan.status === "not_started" ? "7 дней с первого объявления" : "Срок истёк"]])}</section><section class="panel"><h3>Telegram-аккаунт</h3>${a ? dl([["Telegram ID", a.telegram_id], ["Подключён", fmt(a.created_at)], ["Обновлён", fmt(a.updated_at)], ["Ожидание Telegram до", fmt(a.retry_after)]]) : `<p class="subtle">Аккаунт не подключён.</p>`}<h3 class="actions">Текущий шаг в боте</h3>${dl([["Раздел", data.draft?.kind || "—"], ["Шаг", data.draft?.step || "—"], ["Обновлён", fmt(data.draft?.updated_at)]])}</section></div>`;
}
function records(data) {
  const kind = route.tab;
  if (!data.rows.length) return `<div class="panel empty">В этом разделе пока нет записей.</div>`;
  return data.rows.map(r => {
    let title, pairs, extra = "", status;
    if (kind === "announcements" || kind === "templates") {
      title = `${kind === "templates" ? "Шаблон" : "Объявление"} #${r.id}`; status = r.status;
      pairs = [["Создано", fmt(r.created_at)], ["Обновлено", fmt(r.updated_at)]];
      pairs.push(["Интервал", r.interval_minutes ? `${r.interval_minutes} минут` : "Не настроен"], ["Время отправки", windowText(r)], ["Первый запуск", names[r.first_run_mode] || "Не настроен"], ["Контактное имя", r.contact_name], ["Телефон", r.contact_phone], ["Telegram", r.contact_telegram], ["Группы", (r.groups || []).map(g => `${g.title} (${g.chat_id})`).join(", ") || "—"]);
      if (kind === "announcements") pairs.push(["Следующая отправка", fmt(r.next_run_at)], ["Последний запуск", fmt(r.last_run_at)], ["Цикл отправки", fmt(r.delivery_cycle_at)]);
      extra = `<div class="text">${esc(r.text)}</div>${media(kind, r.id, r.photo_count)}`;
    } else if (kind === "groups") {
      title = r.title; status = r.is_active ? "active" : "paused";
      pairs = [["Chat ID", r.chat_id], ["Тип", r.chat_type], ["Можно отправлять", yes(r.can_post)], ["Пользователь — админ", yes(r.is_admin)], ["Медленный режим", `${r.slow_mode_delay} сек.`], ["Подключена", fmt(r.connected_at)], ["Подключил Telegram ID", r.connected_by_telegram_id], ["Проверена", fmt(r.verified_at)], ["Повтор после", fmt(r.retry_after)]];
    } else if (kind === "deliveries") {
      title = `Отправка #${r.id}`; status = r.status;
      pairs = [["Объявление", `#${r.announcement_id}`], ["Группа", `${r.title} (${r.chat_id})`], ["Запланирована", fmt(r.scheduled_at)], ["Отправлена", fmt(r.sent_at)], ["Создана запись", fmt(r.created_at)], ["Отправитель", r.sender_telegram_id], ["ID сообщений", (r.telegram_message_ids || [r.telegram_message_id]).filter(Boolean).join(", ") || "—"], ["Код ошибки", r.error_code]];
    } else if (kind === "tariffs") {
      title = `${names[r.action]} #${r.id}`;
      pairs = [["Дата", fmt(r.created_at)], ["Администратор ID", r.admin_telegram_id], ["Сумма", `${num(r.amount_sum)} сум`], ["Предыдущий срок", fmt(r.previous_until)], ["Новый срок", fmt(r.paid_until)], ["Примечание", r.note || "—"]];
    } else {
      title = "Уведомление об ответе в группе";
      pairs = [["Chat ID", r.chat_id], ["Сообщение ID", r.message_id], ["Дата", fmt(r.created_at)]];
    }
    return `<article class="record"><div class="record-title"><h3>${esc(title)}</h3>${status ? badge(status) : ""}</div>${dl(pairs)}${extra}</article>`;
  }).join("") + pager(data);
}
function messages(data) {
  return `<div class="conversation-tools"><span class="subtle">Последние 50 сообщений · Ташкент</span>${data.hasOlder ? `<button class="secondary" data-before="${data.rows[0].id}">Ранние сообщения</button>` : route.before ? `<a href="${userLink(currentUser.user, "messages")}">К новым сообщениям →</a>` : ""}</div><div class="thread">${data.rows.length ? data.rows.map(m => `<article class="bubble ${m.direction}"><p>${esc(m.text || names[m.kind] || "Вложение")}</p>${m.has_file ? media("support", m.id, 1, m.file_name || (m.kind === "photo" ? "photo.jpg" : names[m.kind] || "Вложение")) : ""}<small>${names[m.direction]} ${m.admin_telegram_id ? `· ID ${esc(m.admin_telegram_id)}` : ""} · ${fmt(m.created_at)}</small><small>${esc(names[m.delivery_status] || m.delivery_status)}${m.error_code ? ` · ${esc(m.error_code)}` : ""}</small>${["unknown", "sending"].includes(m.delivery_status) ? `<small>Доставка пока не подтверждена. Повторное сообщение может создать дубликат.</small>` : ""}</article>`).join("") : `<p class="empty">Переписка ещё не началась.</p>`}</div><form id="reply-form" class="panel composer"><label for="reply-text">Ответ пользователю через бот</label><textarea id="reply-text" rows="3" maxlength="3500" placeholder="Напишите ответ…" required>${esc(drafts.get(route.user) || "")}</textarea><div class="row actions"><span class="subtle">Текст до 3500 символов</span><button type="submit">Отправить ответ</button></div></form>`;
}
async function load() {
  if (!authorized) return;
  const turn = ++generation;
  for (const url of blobs) URL.revokeObjectURL(url); blobs.clear();
  const parsed = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  route = { view: "overview", tab: "profile", page: "1", ...parsed };
  if (!tabNames[route.tab]) route.tab = "profile";
  if (!["overview", "users", "inbox", "broadcasts"].includes(route.view)) route.view = "overview";
  const user = route.user && /^[1-9][0-9]{0,17}$/.test(route.user) ? route.user : null;
  $("#heading").textContent = user ? "Карточка пользователя" : { overview: "Обзор", users: "Пользователи", inbox: "Обращения", broadcasts: "Рассылки" }[route.view];
  document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("active", a.dataset.nav === (user ? "users" : route.view)));
  $("#content").setAttribute("aria-busy", "true");
  $("#content").innerHTML = `<p class="empty">Загружаем данные…</p>`;
  try {
    if (user) {
      const detail = await api(`/users/${user}`);
      const tab = route.tab;
      const data = tab === "profile" ? detail : await api(`/users/${user}/${tab === "messages" ? `messages${route.before ? `?before=${encodeURIComponent(route.before)}` : ""}` : `records?kind=${tab}&page=${encodeURIComponent(route.page)}`}`);
      if (turn !== generation) return;
      currentUser = detail; $("#content").innerHTML = profileShell(detail);
      $("#user-content").innerHTML = tab === "profile" ? profile(data) : tab === "messages" ? messages(data) : records(data);
      if (tab === "messages" && data.rows.length) await api(`/users/${user}/read`, { throughId: String(data.rows.at(-1).id) });
    } else if (route.view === "broadcasts") {
      const content = await broadcasts.render(route);
      if (turn !== generation) return;
      $("#content").innerHTML = content;
    } else {
      const query = new URLSearchParams({ page: route.page, search: route.search || "", status: route.status || "" });
      const data = await api(`/${route.view}${route.view === "overview" ? "" : `?${query}`}`);
      if (turn !== generation) return;
      $("#content").innerHTML = route.view === "overview" ? overview(data) : route.view === "users" ? users(data) : inbox(data);
      if (route.view === "overview") $("#unread").textContent = data.unread ? num(data.unread) : "";
    }
  } catch (error) { if (turn === generation) { notice(error.message, true); if (!$("#user-content")) $("#content").innerHTML = `<p class="empty">Не удалось загрузить данные. Нажмите «Обновить».</p>`; } }
  finally { if (turn === generation) $("#content").setAttribute("aria-busy", "false"); }
}
function openTariff(action) {
  const key = `${route.user}:${action}`;
  pendingTariff = pendingTariffs.get(key) || { user: route.user, action, requestId: crypto.randomUUID() };
  pendingTariffs.set(key, pendingTariff);
  const revoke = action === "revoke";
  $("#dialog-title").textContent = revoke ? "Отключить платный тариф?" : "Включить 30 дней за 20 000 сум?";
  const base = Math.max(Date.now(), new Date(currentUser.user.trial_ends_at || 0).getTime(), new Date(currentUser.user.paid_until || 0).getTime());
  $("#dialog-description").textContent = `${currentUser.user.first_name || "Пользователь"} · ID ${currentUser.user.telegram_id}. ${revoke ? "Платный доступ будет отключён. Действующий пробный срок сохранится. Денежный возврат эта кнопка не выполняет." : `Подтвердите получение оплаты. Доступ будет продлён до ${fmt(base + 30 * 86400000)} по времени Ташкента. Оставшийся срок сохраняется.`}`;
  $("#tariff-note").value = pendingTariff.note || ""; $("#tariff-note").disabled = pendingTariff.note !== undefined; $("#dialog-error").hidden = true;
  $("#dialog-submit").textContent = revoke ? "Отключить тариф" : "Подтвердить оплату и включить";
  $("#dialog-submit").className = revoke ? "danger" : "";
  $("#tariff-dialog").showModal();
}
$("#tariff-form").addEventListener("submit", async event => {
  event.preventDefault(); if (mutation) return; mutation = true;
  pendingTariff.note ??= $("#tariff-note").value;
  $("#tariff-note").disabled = true; $("#dialog-submit").disabled = true; $("#dialog-cancel").disabled = true;
  try {
    const result = await api(`/users/${pendingTariff.user}/tariff`, pendingTariff);
    $("#tariff-dialog").close(); notice(result.action === "activate" ? `Тариф включён до ${fmt(result.paid_until)}.` : "Платный тариф отключён.");
    pendingTariffs.delete(`${pendingTariff.user}:${pendingTariff.action}`); pendingTariff = undefined; await load();
  } catch (error) { $("#dialog-error").textContent = `${error.message} Повторная попытка использует тот же запрос и не продлит тариф дважды.`; $("#dialog-error").hidden = false; }
  finally { mutation = false; $("#dialog-submit").disabled = false; $("#dialog-cancel").disabled = false; }
});
$("#dialog-cancel").addEventListener("click", () => { if (!mutation) $("#tariff-dialog").close(); });
$("#tariff-dialog").addEventListener("cancel", event => { if (mutation) event.preventDefault(); });
$("#content").addEventListener("input", event => { if (event.target.id === "reply-text") drafts.set(route.user, event.target.value); });
$("#content").addEventListener("submit", async event => {
  event.preventDefault();
  if (event.target.id === "search-form") { location.hash = href({ view: "users", ...Object.fromEntries(new FormData(event.target)), page: "1" }); return; }
  if (event.target.id !== "reply-form" || mutation) return;
  const user = route.user, input = $("#reply-text"), text = input.value.trim(), button = event.target.querySelector("button");
  if (!text) return;
  const replyPending = pendingReplies.get(user) || { user, text, requestId: crypto.randomUUID() };
  if (replyPending.text !== text) {
    input.value = replyPending.text; drafts.set(user, replyPending.text);
    notice("Восстановлен текст предыдущего запроса. Повторите его, чтобы проверить доставку, затем можно написать новый ответ.", true); return;
  }
  pendingReplies.set(user, replyPending);
  mutation = true; button.disabled = true; input.disabled = true;
  try {
    const result = await api(`/users/${user}/reply`, replyPending);
    if (["sent", "sending", "unknown"].includes(result.delivery_status)) drafts.delete(user);
    notice(result.delivery_status === "sent" ? "Ответ отправлен пользователю." : result.delivery_status === "failed" ? `Telegram отклонил отправку (${result.error_code}). Текст сохранён, его можно отправить повторно.` : "Доставка не подтверждена. Обновите переписку и проверьте статус перед новым ответом.", result.delivery_status !== "sent");
    pendingReplies.delete(user); await load();
  } catch (error) { notice(`${error.message} Повторите с тем же текстом: второй экземпляр сообщения не будет отправлен.`, true); }
  finally { mutation = false; button.disabled = false; input.disabled = false; }
});
document.addEventListener("click", event => { if (mutation && event.target.closest("a")) event.preventDefault(); });
$("#content").addEventListener("click", async event => {
  const button = event.target.closest("button"); if (!button || mutation) return;
  if (button.dataset.page) { location.hash = href({ ...route, page: button.dataset.page }); return; }
  if (button.dataset.before) { location.hash = href({ ...route, before: button.dataset.before }); return; }
  if (button.dataset.tariff) { openTariff(button.dataset.tariff); return; }
  if (button.dataset.file) {
    button.disabled = true;
    try {
      const blob = await api(`/files/${button.dataset.file}`, undefined, true), url = URL.createObjectURL(blob); blobs.add(url);
      if (!button.isConnected) { URL.revokeObjectURL(url); blobs.delete(url); return; }
      if (blob.type.startsWith("image/")) { const img = document.createElement("img"); img.src = url; img.alt = "Вложение пользователя"; img.className = "media-preview"; button.parentElement.append(img); }
      const link = document.createElement("a"); link.href = url; link.download = button.dataset.name; link.textContent = "Скачать вложение"; button.replaceWith(link);
    } catch (error) { notice(error.message, true); button.disabled = false; }
  }
});
$("#refresh").addEventListener("click", () => { if (!mutation) { notice(""); void load(); } });
window.addEventListener("hashchange", () => { if (!mutation) { notice(""); void load(); } });
async function init() {
  tg = window.Telegram?.WebApp; tg?.ready(); tg?.expand(); auth = tg?.initData;
  const token = new URLSearchParams(location.hash.slice(1)).get("login");
  if (token) {
    auth = undefined;
    history.replaceState(null, "", "/admin");
    $("#heading").textContent = "Вход в админку";
    $("#content").innerHTML = `<section class="panel"><h2>Войти как администратор</h2><p>Ссылка из бота действует 5 минут. Вход в этом браузере сохранится на 12 часов.</p><p class="subtle">Если страница открылась внутри Telegram, сначала выберите «Открыть в браузере» в меню Telegram. До входа ссылка остаётся доступной.</p><button id="browser-login">Войти</button></section>`;
    // Keep the link until the actual exchange so Telegram can transfer it to the external browser.
    history.replaceState(null, "", `#login=${encodeURIComponent(token)}`);
    $("#content").setAttribute("aria-busy", "false");
    $("#browser-login").addEventListener("click", async event => {
      const button = event.currentTarget; button.disabled = true;
      try { await api("/session", { token }); history.replaceState(null, "", "/admin"); await enter(); }
      catch (error) { notice(error.message, true); button.disabled = false; }
    });
    return;
  }
  await enter();
}
async function enter() {
  try { await api("/overview"); }
  catch (error) {
    notice(error.message, true);
    $("#content").innerHTML = `<div class="panel"><h2>Вход через Telegram</h2><p>Отправьте боту команду <strong>/admin</strong> и нажмите «Открыть в браузере».</p><p class="subtle">Доступ открыт только администраторам.</p></div>`;
    $("#content").setAttribute("aria-busy", "false"); return;
  }
  authorized = true; notice(""); $("#logout").hidden = !!auth;
  if (auth) void prepareBrowserLink();
  await load();
  setInterval(async () => { if (document.hidden || mutation) return; try { const data = await api("/overview"); $("#unread").textContent = data.unread ? num(data.unread) : ""; } catch { /* Keep drafts and the current page; manual refresh shows actionable errors. */ } }, 30000);
}
async function prepareBrowserLink() {
  try { const link = await api("/browser-link", {}); browserLink = { ...link, until: Date.now() + link.expiresIn * 1000 - 10000 }; $("#browser-open").hidden = false; }
  catch { $("#browser-open").hidden = true; }
}
$("#browser-open").addEventListener("click", async () => {
  if (!browserLink || Date.now() >= browserLink.until) { await prepareBrowserLink(); notice("Ссылка обновлена. Нажмите «Открыть в браузере» ещё раз."); return; }
  if (tg?.openLink && auth) tg.openLink(browserLink.url, { try_instant_view: false });
  else window.open(browserLink.url, "_blank", "noopener,noreferrer");
  browserLink = undefined; void prepareBrowserLink();
});
$("#logout").addEventListener("click", async () => {
  if (mutation) return;
  try { await api("/logout", {}); location.replace("/admin"); } catch (error) { notice(error.message, true); }
});
void init();
