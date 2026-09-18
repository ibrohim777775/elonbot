"use strict";
class BroadcastView {
  constructor(helpers) {
    Object.assign(this, helpers);
    this.draft = { textRu: "", textUz: "", audience: "all", name: "" };
    this.selected = new Map(); this.templates = []; this.search = ""; this.userPage = 1; this.sending = false;
    const root = document.querySelector("#content");
    root.addEventListener("keydown", event => {
      if (event.key === "Enter" && event.target.id === "bc-search") {
        event.preventDefault(); this.search = event.target.value.trim(); this.userPage = 1; void this.loadUsers();
      }
    });
    root.addEventListener("input", event => {
      const field = event.target.dataset.bfield;
      if (field) this.draft[field] = event.target.value;
    });
    root.addEventListener("change", event => {
      const target = event.target;
      if (target.id === "bc-audience") {
        this.draft.audience = target.value;
        document.querySelector("#bc-selection").hidden = target.value !== "selected";
      }
      if (target.id === "bc-template") {
        const template = this.templates.find(t => String(t.id) === target.value);
        if (template) {
          this.draft.textRu = template.text_ru; this.draft.textUz = template.text_uz;
          document.querySelector("#bc-ru").value = this.draft.textRu;
          document.querySelector("#bc-uz").value = this.draft.textUz;
        }
      }
      if (target.dataset.recipient) {
        if (target.checked && this.selected.size >= 1000) { target.checked = false; this.notice("Можно выбрать до 1000 пользователей.", true); return; }
        if (target.checked) this.selected.set(target.dataset.recipient, target.dataset.label);
        else this.selected.delete(target.dataset.recipient);
        this.updateSelection();
      }
    });
    root.addEventListener("submit", event => {
      if (event.target.id !== "bc-compose") return;
      event.preventDefault(); void this.mutate(async () => {
        if (this.draft.audience === "selected" && !this.selected.size) throw new Error("Выберите хотя бы одного пользователя.");
        const payload = { textRu: this.draft.textRu, textUz: this.draft.textUz, audience: this.draft.audience,
          userIds: this.draft.audience === "all" ? [] : [...this.selected.keys()].sort() };
        const signature = JSON.stringify(payload);
        if (this.previewRequest?.signature !== signature) this.previewRequest = { signature, requestId: crypto.randomUUID() };
        const result = await this.api("/broadcasts", { ...payload, requestId: this.previewRequest.requestId });
        this.go({ id: result.id });
      });
    });
    root.addEventListener("click", event => {
      const button = event.target.closest("button"); if (!button || this.sending) return;
      if (button.dataset.bpage) this.go({ ...this.route, page: button.dataset.bpage });
      if (button.hasAttribute("data-bsearch")) { this.search = document.querySelector("#bc-search").value.trim(); this.userPage = 1; void this.loadUsers(); }
      if (button.dataset.buserpage) { this.userPage = Number(button.dataset.buserpage); void this.loadUsers(); }
      if (button.hasAttribute("data-bclear")) { this.selected.clear(); this.updateSelection(); root.querySelectorAll("[data-recipient]").forEach(c => { c.checked = false; }); }
      if (button.dataset.bremove) { this.selected.delete(button.dataset.bremove); this.updateSelection(); root.querySelectorAll("[data-recipient]").forEach(c => { c.checked = this.selected.has(c.dataset.recipient); }); }
      if (button.hasAttribute("data-bsave")) void this.mutate(async () => {
        if (!this.draft.name.trim()) throw new Error("Введите название шаблона.");
        await this.api("/broadcast-templates", this.draft);
        this.templates = (await this.api("/broadcast-templates")).rows;
        document.querySelector("#bc-template").innerHTML = this.templateOptions();
        this.notice("Шаблон сохранён. Его можно выбрать для следующей рассылки.");
      });
      if (button.dataset.baction) void this.mutate(async () => {
        const result = await this.api(`/broadcasts/${this.route.id}/${button.dataset.baction}`, {});
        this.previewRequest = undefined;
        await this.reload();
        this.notice(result.status === "cancelled" ? "Рассылка остановлена. Уже отправленные сообщения остаются у пользователей." : "Рассылка запущена. Можно закрыть страницу — отправка продолжится.");
      });
      if (button.hasAttribute("data-bedit")) {
        const row = this.current;
        this.draft = { textRu: row.text_ru, textUz: row.text_uz, audience: row.audience, name: "" };
        this.selected = new Map(row.selected_ids.map(id => [String(id), `Пользователь #${id}`])); this.previewRequest = undefined;
        this.go({ compose: "1" });
      }
    });
    setInterval(() => {
      if (!document.hidden && !this.sending && this.current?.status === "queued" && location.hash.includes("view=broadcasts") && location.hash.includes(`id=${this.current.id}`)) void this.reload();
    }, 5000);
  }
  async mutate(work) {
    if (this.sending) return;
    this.sending = true; this.busy(true); this.notice("");
    const controls = [...document.querySelectorAll("#content button, #content input, #content textarea, #content select")].filter(e => !e.disabled);
    controls.forEach(e => { e.disabled = true; });
    let next;
    try { await work(); } catch (error) { this.notice(error.message, true); }
    finally { this.sending = false; this.busy(false); controls.forEach(e => { e.disabled = false; }); next = this.nextRoute; this.nextRoute = undefined; }
    if (next) this.go(next);
  }
  go(values = {}) {
    if (this.sending) { this.nextRoute = values; return; }
    location.hash = new URLSearchParams({ view: "broadcasts", ...values });
  }
  pager(data, attr = "bpage") {
    const max = Math.max(1, Math.ceil(data.total / 20));
    return `<div class="pager"><button type="button" class="secondary" data-${attr}="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>← Назад</button><span>${data.page} / ${max} · ${this.num(data.total)}</span><button type="button" class="secondary" data-${attr}="${data.page + 1}" ${data.page >= max ? "disabled" : ""}>Далее →</button></div>`;
  }
  status(value) { return ({ draft: "Предпросмотр", queued: "Отправляется", completed: "Завершена", cancelled: "Остановлена", pending: "В очереди", sending: "Отправляется", sent: "Доставлено", failed: "Ошибка", unknown: "Не подтверждено" })[value] || value; }
  templateOptions() { return `<option value="">Свой текст</option>` + this.templates.map(t => `<option value="${t.id}">${this.esc(t.name)}</option>`).join(""); }
  selection() {
    return `<div class="row"><strong>Выбрано: ${this.selected.size}</strong><button type="button" class="secondary" data-bclear>Очистить выбор</button></div><div class="selected-users">${[...this.selected].map(([id, name]) => `<button type="button" class="secondary" data-bremove="${id}" aria-label="Убрать ${this.esc(name)}">${this.esc(name)} ×</button>`).join("")}</div>`;
  }
  updateSelection() { document.querySelector("#bc-selected").innerHTML = this.selection(); }
  userList(data) {
    return data.rows.map(u => `<label class="recipient"><input type="checkbox" data-recipient="${u.id}" data-label="${this.esc(u.first_name || u.telegram_id)}" ${this.selected.has(String(u.id)) ? "checked" : ""}><span><strong>${this.esc(u.first_name || "Без имени")}</strong><small>${u.username ? `@${this.esc(u.username)} · ` : ""}${u.telegram_id} · ${u.language === "ru" ? "Русский" : "O'zbekcha"}</small></span></label>`).join("") + (data.rows.length ? "" : `<p class="empty">Пользователи не найдены.</p>`) + this.pager(data, "buserpage");
  }
  async loadUsers() {
    const turn = this.userTurn = (this.userTurn || 0) + 1;
    try {
      const data = await this.api(`/users?${new URLSearchParams({ search: this.search, page: this.userPage })}`);
      if (turn === this.userTurn && document.querySelector("#bc-users")) document.querySelector("#bc-users").innerHTML = this.userList(data);
    } catch (error) { this.notice(error.message, true); }
  }
  async render(route) {
    this.route = { ...route }; this.current = undefined;
    if (route.compose) {
      const [templates, people] = await Promise.all([this.api("/broadcast-templates"), this.api(`/users?${new URLSearchParams({ search: this.search, page: this.userPage })}`)]);
      this.templates = templates.rows;
      const d = this.draft;
      return `<a class="back" href="#view=broadcasts">← История рассылок</a><form id="bc-compose"><section class="panel"><h2>Новая рассылка</h2><p class="subtle">Личное сообщение от бота. Каждый получит текст на выбранном им языке. Для одинакового сообщения вставьте один текст в оба поля.</p><label for="bc-template">Готовый шаблон</label><select id="bc-template">${this.templateOptions()}</select><div class="grid-two broadcast-texts"><label for="bc-ru">Русский<textarea id="bc-ru" data-bfield="textRu" rows="6" maxlength="3500" required placeholder="Текст сообщения на русском">${this.esc(d.textRu)}</textarea></label><label for="bc-uz">O'zbekcha<textarea id="bc-uz" data-bfield="textUz" rows="6" maxlength="3500" required placeholder="O'zbek tilidagi xabar matni">${this.esc(d.textUz)}</textarea></label></div><details><summary>Сохранить текст как шаблон</summary><label for="bc-name">Название шаблона</label><input id="bc-name" data-bfield="name" maxlength="100" value="${this.esc(d.name)}" placeholder="Например: обновление бота"><div class="actions"><button type="button" class="secondary" data-bsave>Сохранить шаблон</button></div></details></section><section class="panel"><h2>Получатели</h2><label for="bc-audience">Кому отправить</label><select id="bc-audience"><option value="all" ${d.audience === "all" ? "selected" : ""}>Всем пользователям бота</option><option value="selected" ${d.audience === "selected" ? "selected" : ""}>Выбрать пользователей</option></select><p class="subtle">Тариф и подключение Telegram-аккаунта не влияют на получение этого сообщения.</p><div id="bc-selection" ${d.audience === "all" ? "hidden" : ""}><div id="bc-selected">${this.selection()}</div><div class="filters actions"><label for="bc-search">Найти пользователя<input id="bc-search" type="search" value="${this.esc(this.search)}" placeholder="Имя, @username или Telegram ID"></label><button type="button" class="secondary" data-bsearch>Найти</button></div><div id="bc-users">${this.userList(people)}</div></div></section><div class="actions"><button type="submit">Проверить перед отправкой →</button></div></form>`;
    }
    if (route.id && /^[1-9][0-9]{0,17}$/.test(route.id)) {
      const data = await this.api(`/broadcasts/${route.id}?page=${encodeURIComponent(route.page || 1)}`); this.current = data;
      const c = data.counts;
      return `<a class="back" href="#view=broadcasts">← История рассылок</a><section class="panel"><div class="row"><h2>Рассылка #${data.id}</h2><span class="badge ${data.status === "completed" ? "sent" : "sending"}">${this.status(data.status)}</span></div><p>Получателей: <strong>${this.num(c.total)}</strong> · Русский: ${c.ru} · O'zbekcha: ${c.uz}</p><p class="subtle">${data.status === "draft" ? "Проверьте текст и список ниже. Отправка начнётся только после нажатия кнопки. Список получателей уже зафиксирован." : `Создана ${this.fmt(data.created_at)} · Администратор ${data.admin_telegram_id}`}</p><div class="grid-two broadcast-texts"><div><h3>Русский</h3><div class="text">${this.esc(data.text_ru)}</div></div><div><h3>O'zbekcha</h3><div class="text">${this.esc(data.text_uz)}</div></div></div>${data.status === "draft" ? `<div class="actions"><button data-baction="start">Отправить ${this.num(c.total)} пользователям</button><button class="secondary" data-bedit>Изменить текст или получателей</button><button class="secondary" data-baction="cancel">Отменить</button></div>` : `<div class="metrics broadcast-counts">${[["Доставлено", c.sent], ["В очереди", c.pending + c.sending], ["Ошибки", c.failed], ["Не подтверждено", c.unknown]].map(([name, n]) => `<div class="metric"><p>${name}</p><strong>${n}</strong></div>`).join("")}</div>${data.status === "queued" ? `<p class="subtle">Отправка продолжается на сервере. Статус обновляется автоматически. При остановке уже начатая отправка может завершиться.</p><button class="secondary" data-baction="cancel">Остановить рассылку</button>` : ""}${c.unknown ? `<p class="subtle">Telegram не подтвердил часть отправок. Эти сообщения автоматически не повторяются, чтобы избежать дубликатов.</p>` : ""}`}</section><h3>Получатели и результат</h3><div class="table-wrap"><table><thead><tr><th>Пользователь</th><th>Язык</th><th>Результат</th></tr></thead><tbody>${data.rows.map(r => `<tr><td>${this.esc(r.first_name || "Без имени")}<small>${r.telegram_id}</small></td><td>${r.language === "ru" ? "Русский" : "O'zbekcha"}</td><td>${this.status(r.status)}${r.error_code ? `<small>${this.esc(r.error_code)}</small>` : ""}</td></tr>`).join("")}</tbody></table></div>${this.pager(data)}`;
    }
    const data = await this.api(`/broadcasts?page=${encodeURIComponent(route.page || 1)}`);
    return `<div class="panel"><div class="row"><div><h2>Сообщения пользователям</h2><p class="subtle">Обновления и новости бота — всем или выбранным получателям.</p></div><a class="button-link" href="#view=broadcasts&compose=1">Создать рассылку</a></div></div>${data.rows.length ? data.rows.map(b => `<a class="inbox-item" href="#view=broadcasts&id=${b.id}"><div class="row"><strong>Рассылка #${b.id}</strong><span>${this.status(b.status)}</span></div><p>${this.esc(b.text_ru.slice(0, 140))}</p><small>${this.fmt(b.created_at)} · Получателей: ${b.total} · Доставлено: ${b.sent} · Ошибки: ${b.failed}</small></a>`).join("") : `<div class="panel empty">Пока нет рассылок. В новой рассылке можно выбрать шаблон «Бот снова работает».</div>`}${this.pager(data)}`;
  }
}
