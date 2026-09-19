import { Bot, Context, InlineKeyboard, Keyboard } from "grammy";
import { Accounts, authErrors } from "./accounts";
import { Config } from "./config";
import { Database, lockUser, one, Queryable } from "./db";
import { Delivery, photosOf } from "./delivery";
import { Groups } from "./groups";
import { t, languageOf, languages, translations, withLanguage, changeLanguage, currentLanguage } from "./i18n";
import { Failure } from "./telegram";
import { logError } from "./log";
import { planState, requireCreationAccess } from "./billing";
import { Support } from "./support";
import { botCommands } from "./commands";
import { AdminAuth } from "./admin-auth";
import { maxAnnouncementPhotos, photoMessageIds, photoCount } from "./media";
import { SendingWindow, formatMinute, nextSendingTime, parseClockTime, parseSendingWindow, validSendingWindow } from "./schedule";

type Wizard = SendingWindow & { kind?: "announcement" | "template"; step?: string; text?: string; photos?: string[];
  photoMessageIds?: number[];
  groups?: string[]; groupPage?: number; interval?: number; saveTemplate?: boolean; fromTemplate?: boolean; mode?: string;
  templateId?: string; contact_phone?: string | null; contact_telegram?: string | null; contact_name?: string | null;
  editId?: string; table?: "announcements" | "templates"; candidates?: any[];
  confirmationBack?: "template" | "first_run" | "save_template"; clockManual?: boolean;
  candidatesCached?: boolean; candidatesRetryAt?: number; support?: boolean };
type Ctx = Context & { db: Queryable; userId: string; wizard: Wizard; sendNow?: boolean; notifySupport?: boolean };
const intervals = [5, 10, 15, 20, 60, 120, 180, 300, 480];
const groupsPerPage = 20;
const groupPage = (requested: number, count: number) => Number.isSafeInteger(requested)
  ? Math.max(0, Math.min(requested, Math.ceil(count / groupsPerPage) - 1)) : 0;
function groupNavigation(keyboard: InlineKeyboard, page: number, count: number, action: string) {
  if (count <= groupsPerPage) return;
  if (page > 0) keyboard.text("←", `${action}:${page - 1}`);
  if ((page + 1) * groupsPerPage < count) keyboard.text("→", `${action}:${page + 1}`);
  keyboard.row();
}
const button = (label: string, action: string) => new InlineKeyboard().text(t(label), action);
const confirm = (action: string, back: string) => new InlineKeyboard().text(t("common.yes"), action).text(t("common.no"), back);
const idAt = (parts: string[], index = 2) => /^\d+$/.test(parts[index] ?? "") ? parts[index] : "0";
const windowDescription = (window: SendingWindow) => window.send_start_minute == null || window.send_end_minute == null
  ? t("announcements.window_all") : t("announcements.window_range", {
    start: formatMinute(window.send_start_minute), end: formatMinute(window.send_end_minute),
    overnight: window.send_start_minute > window.send_end_minute ? t("announcements.window_overnight") : "",
  });

async function show(ctx: Ctx, text: string, keyboard?: InlineKeyboard) {
  if (text.length <= 4096 && ctx.callbackQuery?.message?.text) {
    try { await ctx.editMessageText(text, { reply_markup: keyboard }); return; }
    catch (error) { if ((error as Error).message?.includes("message is not modified")) return; }
  }
  for (let start = 0; start < text.length; start += 4000) {
    await ctx.reply(text.slice(start, start + 4000), { reply_markup: start + 4000 >= text.length ? keyboard : undefined });
  }
}
async function owned(ctx: Ctx, table: "templates" | "announcements", id: string) {
  const row = await one(ctx.db, `SELECT * FROM ${table} WHERE id=$1 AND user_id=$2`, [id, ctx.userId]);
  if (!row) throw new Failure("NOT_FOUND");
  return row;
}

export function createBot(config: Config, database: Database, accounts: Accounts, groups: Groups, delivery: Delivery, supportService?: Support) {
  const helpUrl = () => `${config.baseUrl}/help?lang=${currentLanguage()}`;
  const mainKeyboard = () => new Keyboard().text(t("menu.announcements")).text(t("menu.templates")).row()
    .text(t("menu.groups")).text(t("menu.settings")).row().text(t("menu.support"))
    .webApp(t("menu.help"), helpUrl()).resized().persistent();
  const bot = new Bot<Ctx>(config.botToken);
  const support = supportService ?? new Support(database, config, bot.api);
  const wizardBack = (ctx: Ctx, keyboard = new InlineKeyboard()) => {
    if (keyboard.inline_keyboard.at(-1)?.length) keyboard.row();
    return keyboard.text(`⬅️ ${t("common.back")}`, `wizard:back:${ctx.wizard.step}`);
  };
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.chat?.type !== "private") return;
    // Clear Telegram's button spinner before database work or a pending delivery.
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    await database.transaction(async db => {
      // Drafts remain serialized, but opening menus does not wait for uploads or sends.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`elonbot:ui:${ctx.from!.id}`]);
      const user = await one(db, `INSERT INTO users(telegram_id,username,first_name,language) VALUES($1,$2,$3,$4)
        ON CONFLICT(telegram_id) DO UPDATE SET username=$2,first_name=$3,last_activity_at=now(),updated_at=now() RETURNING id,language`,
        [String(ctx.from!.id), ctx.from!.username ?? null, ctx.from!.first_name, languageOf(ctx.from!.language_code)]);
      ctx.userId = String(user.id); ctx.db = db;
      const recorded = await db.query("INSERT INTO processed_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id", [ctx.update.update_id]);
      if (!recorded.rows.length) return;
      const state = await one(db, "SELECT data FROM user_states WHERE user_id=$1 AND updated_at>now()-interval '1 day'", [ctx.userId]);
      ctx.wizard = state?.data ?? {};
      // Retire unfinished template edits saved before templates became read-only.
      if ((ctx.wizard.table === "templates" && ctx.wizard.editId) || (ctx.wizard.kind === "template" && ctx.wizard.templateId)) {
        ctx.wizard = ctx.wizard.support ? { support: true } : {};
      }
      await withLanguage(languageOf(user.language), async () => {
      try { await next(); }
      catch (error) {
        if (!(error instanceof Failure)) throw error;
        if (error.code === "SUBSCRIPTION_EXPIRED") { await tariffMenu(ctx); }
        else {
        const key = error.code === "TEMPLATE_GROUPS_UNAVAILABLE" ? "templates.groups_unavailable" :
          error.code === "SUPPORT_CONTENT_REQUIRED" ? "support.content_required" :
          error.code === "LOGIN_REQUIRED" || error.code === "ALREADY_CONNECTED" ? "account.connect_prompt" :
          error.code === "ANNOUNCEMENT_GROUP_LIMIT" ? "validation.announcement_group_limit" :
          error.code === "ANNOUNCEMENT_LIMIT" ? "validation.limit_reached" :
          error.code === "INVALID_SENDING_WINDOW" ? "announcements.window_invalid" :
          authErrors.has(error.code) ? "account.expired" : error.code === "GROUPS_RATE_LIMITED" ? "groups.rate_limited" :
          error.seconds ? "common.rate_limited" :
          error.code === "CHAT_WRITE_FORBIDDEN" ? "groups.user_cannot_post" : error.code === "GROUP_REQUIRED" ? "validation.group_required" :
          error.code === "NOT_FOUND" ? "common.not_found" : "common.error";
        await ctx.reply(t(key, { seconds: Math.ceil(error.seconds), limit: config.maxGroupsPerAnnouncement }), { reply_markup:
          error.code === "TEMPLATE_GROUPS_UNAVAILABLE" && ctx.wizard.templateId ? templateActions(ctx.wizard.templateId) : undefined });
        }
      }
      });
      await db.query(`INSERT INTO user_states(user_id,data) VALUES($1,$2) ON CONFLICT(user_id)
        DO UPDATE SET data=$2,updated_at=now()`, [ctx.userId, JSON.stringify(ctx.wizard)]);
    });
    if (ctx.sendNow) void delivery.run().catch(error => logError("delivery_tick_failed", error));
    if (ctx.notifySupport) void support.notify(ctx.userId).catch(error => logError("support_notify_failed", error));
  });
  async function settingsMenu(ctx: Ctx) {
    await show(ctx, t("settings.prompt"), new InlineKeyboard()
      .text(t("menu.account"), "settings:account").row()
      .text(t("menu.tariff"), "settings:tariff").row()
      .text(t("menu.language"), "settings:language").row()
      .text(t("common.back"), "menu:main"));
  }
  async function languageMenu(ctx: Ctx) {
    await show(ctx, t("language.choose"), new InlineKeyboard().text("🇺🇿 O'zbekcha", "language:uz").text("🇷🇺 Русский", "language:ru")
      .row().text(t("common.back"), "settings:open"));
  }
  async function helpMenu(ctx: Ctx) {
    await ctx.reply(t("help.prompt"), { reply_markup: new InlineKeyboard().webApp(t("menu.help"), helpUrl())
      .row().text(t("common.back"), "menu:main") });
  }
  async function tariffMenu(ctx: Ctx) {
    const user = await one(ctx.db, "SELECT trial_started_at,trial_ends_at,paid_until FROM users WHERE id=$1", [ctx.userId]);
    const plan = planState(user);
    const until = plan.until ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Tashkent", dateStyle: "short", timeStyle: "short" }).format(plan.until) : "";
    await show(ctx, `${t(`tariff.${plan.status}`, { until })}\n\n${t("tariff.conditions")}`,
      button("menu.support", "support:open").row().text(t("common.back"), "settings:open"));
  }
  async function openSupport(ctx: Ctx) {
    ctx.wizard.support = true;
    await ctx.reply(t("support.prompt"), { reply_markup: button("support.done", "support:done")
      .row().text(t("common.back"), "support:done") });
  }
  const openGroupsApp = async (ctx: Ctx) => {
    await ctx.reply(t("app.open_prompt"), { reply_markup: new InlineKeyboard().webApp(t("app.open"), `${config.baseUrl}/app`)
      .row().text(t("app.continue"), "groups:continue").row().text(t("common.back"), "groups:continue") });
  };

  const listing = async (ctx: Ctx, table: "announcements" | "templates") => {
    const prefix = table === "announcements" ? "ann" : "templates";
    const rows = (await ctx.db.query(`SELECT * FROM ${table} WHERE user_id=$1 ${table === "announcements" ? "AND status<>'deleted'" : ""} ORDER BY updated_at DESC`, [ctx.userId])).rows;
    const keyboard = new InlineKeyboard();
    for (const row of rows) keyboard.text(`${photoCount(row) ? "📷 " : ""}${row.text.replace(/\n/g, " ").slice(0, 36)}`, `${prefix}:show:${row.id}`).row();
    if (ctx.wizard.step === "draft" && ctx.wizard.kind === (table === "templates" ? "template" : "announcement")) {
      keyboard.text(t("announcements.resume"), "wizard:resume").row();
    }
    keyboard.text(t(`${table}.create`), `${prefix}:create`).row().text(t("common.back"), "menu:main");
    await show(ctx, t(`${table}.${rows.length ? "title" : "empty"}`), keyboard);
  };
  const listGroups = async (ctx: Ctx, requestedPage = 0) => {
    const rows = await groups.list(ctx.db, ctx.userId);
    const page = groupPage(requestedPage, rows.length);
    const keyboard = new InlineKeyboard();
    for (const row of rows.slice(page * groupsPerPage, (page + 1) * groupsPerPage)) keyboard.text(`${row.can_post ? "" : "⚠️ "}${row.title.slice(0, 45)}`, `groups:show:${row.id}`).row();
    groupNavigation(keyboard, page, rows.length, "groups:list_page");
    keyboard.text(t("groups.add"), "groups:add").row().text(t("common.back"), "menu:main");
    await show(ctx, t(rows.length ? "groups.title" : "groups.empty"), keyboard);
  };
  const accountMenu = async (ctx: Ctx) => {
    const connected = await one(ctx.db, "SELECT 1 FROM telegram_accounts WHERE user_id=$1", [ctx.userId]);
    const action = connected ? "disconnect" : "connect";
    await show(ctx, t(`account.${action}_prompt`), button(`account.${action}`, `account:${action}`).row().text(t("common.back"), "settings:open"));
  };
  const askGroups = async (ctx: Ctx) => {
    ctx.wizard.step = ctx.wizard.editId ? "edit_groups" : "groups";
    await accounts.params(ctx.db, ctx.userId);
    const rows = (await groups.list(ctx.db, ctx.userId)).filter(row => row.can_post);
    if (!rows.length) { await show(ctx, t("announcements.no_groups"), wizardBack(ctx, button("groups.add", "groups:add"))); return; }
    ctx.wizard.groups ??= [];
    const page = ctx.wizard.groupPage = groupPage(ctx.wizard.groupPage ?? 0, rows.length);
    const keyboard = new InlineKeyboard();
    for (const row of rows.slice(page * groupsPerPage, (page + 1) * groupsPerPage)) keyboard.text(`${ctx.wizard.groups.includes(String(row.id)) ? "✅ " : ""}${row.title.slice(0, 40)}`, `ann:group:${row.id}`).row();
    groupNavigation(keyboard, page, rows.length, "ann:groups_page");
    keyboard.text(t("common.done"), "ann:groups_done");
    await show(ctx, t("announcements.select_groups", { count: ctx.wizard.groups.length, limit: config.maxGroupsPerAnnouncement }), wizardBack(ctx, keyboard));
  };
  const askInterval = async (ctx: Ctx) => {
    ctx.wizard.step = ctx.wizard.editId ? "edit_interval" : "interval";
    const keyboard = new InlineKeyboard();
    for (const value of intervals) keyboard.text(t("language.minutes", { count: value }), `ann:interval:${value}`).row();
    await show(ctx, t("announcements.select_interval"), wizardBack(ctx, keyboard));
  };
  const askWindow = async (ctx: Ctx) => {
    await askClock(ctx, "start");
  };
  async function askClock(ctx: Ctx, part: "start" | "end") {
    ctx.wizard.step = `window_${part}`;
    delete ctx.wizard.clockManual;
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < 24; i++) {
      const minute = (part === "end" ? i + 1 : i) * 60;
      keyboard.text(formatMinute(minute), `ann:clock:${part}:${minute}`);
      if ((i + 1) % 4 === 0) keyboard.row();
    }
    keyboard.text(t("announcements.window_custom"), `ann:clock:${part}:manual`).row();
    keyboard.text(t("announcements.window_all"), "ann:window:all").row()
      .text(t("common.cancel"), ctx.wizard.editId ? `ann:show:${ctx.wizard.editId}` : "ann:cancel");
    await show(ctx, t(`announcements.window_${part}`, { start: formatMinute(ctx.wizard.send_start_minute ?? 0) }), wizardBack(ctx, keyboard));
  }
  async function chooseClock(ctx: Ctx, minute: number) {
    if (ctx.wizard.step === "window_start") {
      if (!Number.isInteger(minute) || minute < 0 || minute >= 1440) throw new Failure("INVALID_SENDING_WINDOW");
      ctx.wizard.send_start_minute = minute; await askClock(ctx, "end");
    } else await saveWindow(ctx, { send_start_minute: ctx.wizard.send_start_minute, send_end_minute: minute });
  }
  async function saveWindow(ctx: Ctx, window: SendingWindow) {
    if (!validSendingWindow(window)) throw new Failure("INVALID_SENDING_WINDOW");
    const w = ctx.wizard;
    delete w.clockManual;
    if (w.editId) {
      await lockUser(ctx.db, ctx.userId);
      const record = await owned(ctx, "announcements", w.editId);
      // A changed window constrains the scheduled run without bypassing its existing delay.
      const next = record.next_run_at ? nextSendingTime(new Date(Math.max(Date.now(), new Date(record.next_run_at).getTime())), window) : null;
      await ctx.db.query(`UPDATE announcements SET send_start_minute=$3,send_end_minute=$4,next_run_at=$5,updated_at=now()
        WHERE id=$1 AND user_id=$2`, [w.editId, ctx.userId, window.send_start_minute ?? null, window.send_end_minute ?? null, next]);
      const editId = w.editId; ctx.wizard = {};
      await ctx.reply(t("announcements.window_saved")); await showCard(ctx, "announcements", editId);
    } else {
      Object.assign(w, window);
      await askFirstRun(ctx);
    }
  }
  async function askFirstRun(ctx: Ctx) {
    const w = ctx.wizard;
    w.step = "first_run";
    await show(ctx, t("announcements.select_first_run"), wizardBack(ctx, new InlineKeyboard().text(t("announcements.immediate"), "ann:first:immediate").text(t("announcements.scheduled"), "ann:first:scheduled")));
  }
  async function askSaveTemplate(ctx: Ctx) {
    ctx.wizard.step = "save_template";
    await show(ctx, t("announcements.save_template"), wizardBack(ctx, confirm("ann:save_template:yes", "ann:save_template:no")));
  }
  async function draftDescription(ctx: Ctx, w: Wizard) {
    const rows = w.groups?.length ? (await ctx.db.query("SELECT title,chat_id FROM groups WHERE id=ANY($1::bigint[]) ORDER BY id", [w.groups])).rows : [];
    return t("templates.settings", { interval: w.interval!, groups: rows.map(g => `${g.title} (${g.chat_id})`).join(", ") || "—",
      window: windowDescription(w), first: t(`announcements.${w.mode}`), photos: draftPhotoCount(w) });
  }
  const draftPhotoCount = (w: Wizard) => (w.photoMessageIds?.length ?? 0) + (w.photos?.length ?? 0);
  async function draftSources(ctx: Ctx) {
    const w = ctx.wizard;
    if (!w.photos?.length) return;
    // Reusing an old template also produces a new record without legacy file IDs.
    // These preview messages stay in Telegram; only their message IDs enter the new draft.
    const messages = w.photos.length === 1 ? [await ctx.replyWithPhoto(w.photos[0])] :
      await ctx.replyWithMediaGroup(w.photos.map(media => ({ type: "photo" as const, media })));
    w.photoMessageIds = [...(w.photoMessageIds ?? []), ...messages.map(message => message.message_id)];
    delete w.photos;
  }
  async function previewPhoto(ctx: Ctx, ids: number[], legacy: string[] = []) {
    try {
      if (ids.length) await ctx.api.copyMessage(ctx.chat!.id, ctx.chat!.id, ids[0], { caption: "" });
      else if (legacy.length) await ctx.replyWithPhoto(legacy[0]);
    } catch {
      // A removed source must not hide the card's edit/delete actions.
      await ctx.reply(t("delivery.photo_unavailable"));
    }
  }
  const contentDescription = (w: Wizard) => [w.text, w.contact_name, w.contact_phone, w.contact_telegram].filter(Boolean).join("\n");
  async function showConfirmation(ctx: Ctx) {
    const w = ctx.wizard;
    w.confirmationBack = w.step === "save_template" ? "save_template" : w.step === "first_run" ? "first_run" : w.fromTemplate ? "template" : "first_run";
    w.step = "confirm";
    const legacyPreview = !!w.photos?.length;
    await draftSources(ctx);
    if (!legacyPreview) await previewPhoto(ctx, w.photoMessageIds ?? []);
    await show(ctx, `${t(w.kind === "template" ? "templates.preview" : "announcements.preview", {
      text: contentDescription(w), interval: w.interval!, groups: w.groups!.length, window: windowDescription(w),
    })}\n\n${await draftDescription(ctx, w)}${draftPhotoCount(w) ? `\n\n${t("announcements.keep_photos")}` : ""}`, wizardBack(ctx, new InlineKeyboard()
      .text(t(w.kind === "template" ? "common.save" : "announcements.start"), w.kind === "template" ? "templates:save" : "ann:confirm")
      .text(t("common.cancel"), "ann:cancel")));
  }
  const templateDraft = async (ctx: Ctx, id: string, kind: "template" | "announcement"): Promise<Wizard> => {
    const row = await owned(ctx, "templates", id);
    const selected = (await ctx.db.query("SELECT group_id FROM template_groups WHERE template_id=$1 ORDER BY group_id", [id])).rows;
    return { kind, templateId: id, fromTemplate: kind === "announcement", saveTemplate: false,
      text: row.text, photos: photoMessageIds(row).length ? [] : photosOf(row), photoMessageIds: photoMessageIds(row),
      groups: selected.map(g => String(g.group_id)), interval: row.interval_minutes,
      mode: row.first_run_mode, send_start_minute: row.send_start_minute, send_end_minute: row.send_end_minute,
      contact_phone: row.contact_phone, contact_telegram: row.contact_telegram, contact_name: row.contact_name };
  };
  const settingsReady = (w: Wizard) => intervals.includes(w.interval!) && ["immediate", "scheduled"].includes(w.mode!) && validSendingWindow(w) && !!w.groups?.length;
  const templateActions = (id: string) => button("groups.add", "groups:add").row().text(t("common.back"), `templates:show:${id}`);
  async function useTemplate(ctx: Ctx, id: string) {
    const draft = await templateDraft(ctx, id, "announcement");
    // Selecting a different template invalidates any previous launch confirmation, even if this one needs repair.
    ctx.wizard = draft;
    await requireCreationAccess(ctx.db, ctx.userId); await accounts.params(ctx.db, ctx.userId);
    const available = new Set((await groups.list(ctx.db, ctx.userId)).filter(g => g.can_post).map(g => String(g.id)));
    if (!settingsReady(draft)) {
      // Legacy text-only templates supply content for a new announcement; the saved template is not edited.
      draft.groups = draft.groups!.filter(g => available.has(g));
      await ctx.reply(t("templates.needs_settings")); await askGroups(ctx); return;
    }
    if (draft.groups!.some(g => !available.has(g))) { await show(ctx, t("templates.groups_unavailable"), templateActions(id)); return; }
    if (draft.groups!.length > config.maxGroupsPerAnnouncement) {
      await ctx.reply(t("validation.announcement_group_limit", { limit: config.maxGroupsPerAnnouncement }));
      await askGroups(ctx); return;
    }
    await showConfirmation(ctx);
  }
  function validateContent(w: Wizard) {
    if (!w.text || w.text.length > 4096 || !settingsReady(w) || draftPhotoCount(w) > maxAnnouncementPhotos) throw new Failure("INVALID_CONTENT");
  }
  const saveTemplate = async (ctx: Ctx) => {
    const w = ctx.wizard;
    if (w.templateId || w.fromTemplate) throw new Failure("NOT_FOUND");
    validateContent(w);
    await draftSources(ctx);
    const values = [ctx.userId, w.text, null, JSON.stringify([]), w.interval, w.mode,
      w.send_start_minute ?? null, w.send_end_minute ?? null, w.contact_phone ?? null, w.contact_telegram ?? null, w.contact_name ?? null];
    values.push(JSON.stringify(w.photoMessageIds ?? []));
    const row = await one(ctx.db, `INSERT INTO templates(user_id,text,photo_file_id,photo_file_ids,interval_minutes,first_run_mode,
      send_start_minute,send_end_minute,contact_phone,contact_telegram,contact_name,photo_message_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, values);
    const id = String(row.id);
    for (const group of w.groups!) await ctx.db.query("INSERT INTO template_groups(template_id,group_id) VALUES($1,$2)", [id, group]);
    return id;
  };
  const finishContent = async (ctx: Ctx) => {
    await askGroups(ctx);
  };
  async function acceptPhoto(ctx: Ctx) {
    if (!ctx.message?.forward_origin) { await ctx.reply(t("announcements.send_ready_photo")); return false; }
    const w = ctx.wizard;
    w.photoMessageIds ??= [];
    if (w.photoMessageIds.includes(ctx.message.message_id)) return false;
    if (draftPhotoCount(w) >= maxAnnouncementPhotos) { await ctx.reply(t("announcements.photo_limit")); return false; }
    w.photoMessageIds.push(ctx.message.message_id);
    w.photoMessageIds.sort((a, b) => a - b);
    return true;
  }
  const showCard = async (ctx: Ctx, table: "announcements" | "templates", id: string) => {
    const row = await owned(ctx, table, id);
    const prefix = table === "templates" ? "templates" : "ann";
    const keyboard = new InlineKeyboard();
    if (table === "announcements") keyboard.text(t("common.edit"), `ann:edit:${id}`).row();
    else keyboard.text(t("templates.use"), `templates:use:${id}`).row();
    keyboard.text(t(table === "templates" ? "templates.delete" : "common.delete"), `${prefix}:${table === "templates" ? "delete" : "delete_request"}:${id}`).row()
      .text(t("common.back"), `${prefix}:list`);
    const count = table === "announcements" ? (await one(ctx.db, "SELECT count(*)::int n FROM announcement_groups WHERE announcement_id=$1", [id])).n : 0;
    let text = t(`${table}.details`, { text: contentDescription(row), interval: row.interval_minutes, groups: count, window: windowDescription(row) });
    if (table === "templates") {
      const draft = await templateDraft(ctx, id, "template");
      text += `\n\n${settingsReady(draft) ? await draftDescription(ctx, draft) : t("templates.needs_settings")}`;
    }
    await previewPhoto(ctx, photoMessageIds(row), photosOf(row));
    await show(ctx, text, keyboard);
  };

  async function askContent(ctx: Ctx) {
    const w = ctx.wizard; w.step = "content";
    const keyboard = new InlineKeyboard();
    if (w.text) keyboard.text(t("common.continue"), "ann:content_done").row();
    if (w.kind === "announcement") keyboard.text(t("announcements.from_template"), "ann:create:template");
    await show(ctx, t(w.text || draftPhotoCount(w) ? "announcements.content_saved" : "announcements.create_instruction"), wizardBack(ctx, keyboard));
  }
  async function editMenu(ctx: Ctx, id: string) {
    await owned(ctx, "announcements", id);
    ctx.wizard = { editId: id, table: "announcements", step: "edit_menu" };
    const keyboard = new InlineKeyboard();
    for (const field of ["text", "photo", "contact", "name", "groups", "interval", "window"]) keyboard.text(t(`announcements.edit_${field}`), `ann:edit_${field}:${id}`).row();
    await show(ctx, t("announcements.edit_menu"), wizardBack(ctx, keyboard));
  }
  async function goBack(ctx: Ctx) {
    const w = ctx.wizard;
    if (w.support) {
      delete w.support;
      await ctx.reply(t("support.closed"), { reply_markup: mainKeyboard() }); return;
    }
    if (w.clockManual && ["window_start", "window_end", "window", "edit_window"].includes(w.step ?? "")) {
      await askClock(ctx, w.step === "window_end" ? "end" : "start"); return;
    }
    if (w.step === "window_end") { await askClock(ctx, "start"); return; }
    if (w.editId && w.table === "announcements") {
      if (w.step === "edit_menu") { await showCard(ctx, "announcements", w.editId); ctx.wizard = {}; }
      else await editMenu(ctx, w.editId);
      return;
    }
    if (w.kind) {
      switch (w.step) {
        case "template_picker": case "photos": case "caption": case "groups": await askContent(ctx); return;
        case "interval": await askGroups(ctx); return;
        case "window": case "window_start": await askInterval(ctx); return;
        case "first_run": await askClock(ctx, w.send_start_minute != null && w.send_end_minute != null ? "end" : "start"); return;
        case "save_template": await askFirstRun(ctx); return;
        case "confirm":
          if ((w.confirmationBack === "template" || (!w.confirmationBack && w.fromTemplate)) && w.templateId) {
            await showCard(ctx, "templates", w.templateId); ctx.wizard = {};
          } else if (w.confirmationBack === "save_template" || (!w.confirmationBack && w.kind === "announcement" && !w.fromTemplate)) await askSaveTemplate(ctx);
          else await askFirstRun(ctx);
          return;
        case "content":
          w.step = "draft";
          await listing(ctx, w.kind === "template" ? "templates" : "announcements"); return;
      }
    }
    await ctx.reply(t("start.choose_section"), { reply_markup: mainKeyboard() });
  }

  bot.command(["start", "boshlash"], async ctx => {
    ctx.wizard = {};
    await ctx.reply(t("start.welcome"), { reply_markup: new InlineKeyboard().webApp(t("menu.help"), helpUrl()) });
    await ctx.reply(t("start.choose_section"), { reply_markup: mainKeyboard() });
    await ctx.api.setMyCommands(botCommands(currentLanguage(), config.adminIds.includes(String(ctx.from!.id))), { scope: { type: "chat", chat_id: ctx.from!.id } }).catch(error => logError("bot_commands_failed", error));
    if (!await one(ctx.db, "SELECT 1 FROM telegram_accounts WHERE user_id=$1", [ctx.userId])) await accountMenu(ctx);
  });
  bot.command("account", accountMenu);
  bot.command("settings", settingsMenu);
  bot.command("language", languageMenu);
  bot.command("help", helpMenu);
  bot.command("tariff", tariffMenu);
  bot.command("support", openSupport);
  bot.command("admin", async ctx => {
    if (!config.adminIds.includes(String(ctx.from!.id))) { await ctx.reply(t("common.access_denied")); return; }
    const link = await new AdminAuth(config, database).link(ctx.from!, ctx.db);
    await ctx.reply(t("admin.title") + "\n\n" + t("admin.browser_hint"), { reply_markup: new InlineKeyboard().webApp(t("admin.open"), `${config.baseUrl}/admin`)
      .row().url(t("admin.browser"), link.url) });
  });
  bot.command("app", openGroupsApp);
  bot.command("guruh_ulash", async ctx => { ctx.wizard = {}; await listGroups(ctx); });
  bot.command("cancel", async ctx => { ctx.wizard = {}; await ctx.reply(t("common.cancel"), { reply_markup: mainKeyboard() }); });
  bot.command("back", goBack);
  bot.hears([...translations("common.back"), ...translations("common.back").map(label => `⬅️ ${label}`)], goBack);
  bot.command("statistika", async ctx => {
    if (!config.adminIds.includes(String(ctx.from!.id))) { await ctx.reply(t("common.access_denied")); return; }
    const counts = await one(ctx.db, `SELECT (SELECT count(*) FROM users) users,(SELECT count(*) FROM groups) groups,
      (SELECT count(*) FROM announcements WHERE status='active') active,(SELECT count(*) FROM announcements WHERE status='paused') paused,
      (SELECT count(*) FROM delivery_logs WHERE status='sent') sent,(SELECT count(*) FROM delivery_logs WHERE status='failed') failed`);
    await ctx.reply(t("statistics.report", { ...counts, title: t("statistics.title") }));
  });
  for (const [key, table] of [["announcements", "announcements"], ["templates", "templates"]] as const) {
    bot.hears(translations(`menu.${key}`), async ctx => { if (ctx.wizard.step !== "draft") ctx.wizard = {}; await listing(ctx, table); });
  }
  bot.hears(translations("menu.groups"), async ctx => {
    ctx.wizard = {};
    await listGroups(ctx);
  });
  bot.hears(translations("menu.settings"), settingsMenu);
  bot.hears(translations("menu.account"), accountMenu);
  bot.hears(translations("menu.tariff"), tariffMenu);
  bot.hears(translations("menu.support"), openSupport);
  bot.hears(translations("menu.language"), languageMenu);
  bot.hears(translations("menu.help"), helpMenu);

  bot.on("callback_query:data", async ctx => {
    if (ctx.callbackQuery.data.startsWith("wizard:back:")) {
      if (ctx.callbackQuery.data.slice("wizard:back:".length) !== ctx.wizard.step) { await ctx.reply(t("common.not_found")); return; }
      await goBack(ctx); return;
    }
    if (ctx.callbackQuery.data === "wizard:resume") {
      if (!ctx.wizard.kind || ctx.wizard.step !== "draft") throw new Failure("NOT_FOUND");
      await askContent(ctx); return;
    }
    if (ctx.callbackQuery.data === "settings:open") { await settingsMenu(ctx); return; }
    if (ctx.callbackQuery.data === "settings:account") { await accountMenu(ctx); return; }
    if (ctx.callbackQuery.data === "settings:tariff") { await tariffMenu(ctx); return; }
    if (ctx.callbackQuery.data === "settings:language") { await languageMenu(ctx); return; }
    if (ctx.callbackQuery.data === "menu:main") {
      delete ctx.wizard.support;
      await ctx.reply(t("start.choose_section"), { reply_markup: mainKeyboard() }); return;
    }
    if (ctx.callbackQuery.data.startsWith("language:")) {
      const selected = ctx.callbackQuery.data.slice(9);
      if (!languages.includes(selected as any)) throw new Failure("NOT_FOUND");
      const language = languageOf(selected);
      await ctx.db.query("UPDATE users SET language=$2,updated_at=now() WHERE id=$1", [ctx.userId, language]);
      changeLanguage(language);
      await show(ctx, t("language.choose"), new InlineKeyboard().text(`${language === "uz" ? "✅ " : ""}🇺🇿 O'zbekcha`, "language:uz").text(`${language === "ru" ? "✅ " : ""}🇷🇺 Русский`, "language:ru")
        .row().text(t("common.back"), "settings:open"));
      await ctx.reply(t("language.saved"), { reply_markup: mainKeyboard() });
      await ctx.api.setChatMenuButton({ chat_id: ctx.from.id, menu_button: { type: "web_app", text: t("app.open"), web_app: { url: `${config.baseUrl}/app` } } }).catch(error => logError("language_menu_failed", error));
      await ctx.api.setMyCommands(botCommands(language, config.adminIds.includes(String(ctx.from.id))), { scope: { type: "chat", chat_id: ctx.from.id } }).catch(error => logError("language_commands_failed", error));
      return;
    }
    if (ctx.callbackQuery.data === "support:open") { await openSupport(ctx); return; }
    if (ctx.callbackQuery.data === "support:done") {
      delete ctx.wizard.support;
      await ctx.reply(t("support.closed"), { reply_markup: mainKeyboard() }); return;
    }
    const data = ctx.callbackQuery.data;
    const p = data.split(":"); const id = idAt(p); const w = ctx.wizard;
    if (data === "account:connect") {
      await lockUser(ctx.db, ctx.userId);
      const link = await accounts.link(ctx.db, ctx.userId);
      const url = currentLanguage() === "ru" ? link.replace("/account#", "/account?lang=ru#") : link;
      await ctx.reply(t("account.login_instruction"), { reply_markup: new InlineKeyboard().url(t("account.connect"), url)
        .row().text(t("common.back"), "settings:account") }); return;
    }
    if (data === "account:disconnect") {
      await lockUser(ctx.db, ctx.userId);
      await accounts.logout(ctx.db, ctx.userId); await show(ctx, t("account.disconnected"), button("common.back", "settings:account")); return;
    }
    if (data === "groups:list") { await listGroups(ctx); return; }
    if (p[0] === "groups" && p[1] === "list_page") { await listGroups(ctx, Number(id)); return; }
    if (data === "groups:continue") {
      if (w.fromTemplate && w.templateId && settingsReady(w) && (!w.step || w.step === "confirm")) await useTemplate(ctx, w.templateId);
      else if ((w.kind && w.text) || (w.table === "announcements" && w.step === "edit_groups")) await askGroups(ctx); else await listGroups(ctx);
      return;
    }
    if (data === "groups:add" || data === "groups:refresh") {
      await openGroupsApp(ctx); return;
    }
    if (p[0] === "groups" && p[1] === "page") { await candidatePage(ctx, Number(id)); return; }
    if (p[0] === "groups" && p[1] === "connect") {
      const candidate = w.candidates?.[Number(id)];
      if (!candidate) throw new Failure("NOT_FOUND");
      await lockUser(ctx.db, ctx.userId);
      // Resolve against this account's cache; expired lists refresh once, not once per selection.
      // Telegram still authoritatively checks membership and permissions on every send.
      const fresh = (await groups.discover(ctx.db, ctx.userId)).groups.find(g => g.chatId === candidate.chatId);
      if (!fresh) throw new Failure("NOT_FOUND");
      await groups.connect(ctx.db, ctx.userId, fresh);
      await ctx.reply(t("groups.connection_success"));
      if (w.kind && w.text) await askGroups(ctx); else await listGroups(ctx);
      return;
    }
    if (p[0] === "groups" && ["show", "delete", "delete_confirm"].includes(p[1])) {
      const group = (await groups.list(ctx.db, ctx.userId)).find(g => String(g.id) === id);
      if (!group) throw new Failure("NOT_FOUND");
      if (p[1] === "show") await show(ctx, t("groups.details", { title: group.title,
        status: t(group.can_post ? "groups.connected" : "groups.unavailable"), slow_mode: String(group.slow_mode_delay), chat_id: String(group.chat_id) }),
        new InlineKeyboard().text(t("common.delete"), `groups:delete:${id}`).row().text(t("common.back"), "groups:list"));
      else if (p[1] === "delete") await show(ctx, t("groups.disconnect_confirm"), confirm(`groups:delete_confirm:${id}`, `groups:show:${id}`));
      else {
        await lockUser(ctx.db, ctx.userId);
        const affected = (await ctx.db.query(`SELECT a.id FROM announcements a JOIN announcement_groups ag ON ag.announcement_id=a.id
          WHERE a.user_id=$1 AND ag.group_id=$2`, [ctx.userId, id])).rows;
        let failures = 0;
        for (const a of affected) {
          const other = await one(ctx.db, "SELECT 1 FROM announcement_groups WHERE announcement_id=$1 AND group_id<>$2", [a.id, id]);
          if (!other) { failures += await delivery.removePublished(ctx.db, ctx.userId, String(a.id)); await ctx.db.query("DELETE FROM announcements WHERE id=$1 AND user_id=$2", [a.id, ctx.userId]); }
          else await ctx.db.query("DELETE FROM announcement_groups WHERE announcement_id=$1 AND group_id=$2", [a.id, id]);
        }
        await ctx.db.query("DELETE FROM user_groups WHERE user_id=$1 AND group_id=$2", [ctx.userId, id]);
        await ctx.reply(t("groups.disconnected"));
        if (failures) await ctx.reply(t("delivery.cleanup_partial", { count: failures }));
        await listGroups(ctx);
      }
      return;
    }
    if (["ann", "templates"].includes(p[0])) {
      const table = p[0] === "ann" ? "announcements" : "templates";
      if (p[1] === "list") { if (w.step !== "draft") ctx.wizard = {}; await listing(ctx, table); return; }
      if (["create", "create_text", "create_photo"].includes(p[1]) && p.length === 2) {
        if (table === "announcements") { await requireCreationAccess(ctx.db, ctx.userId); await accounts.params(ctx.db, ctx.userId); }
        ctx.wizard = { kind: table === "templates" ? "template" : "announcement", step: "content", photoMessageIds: [] };
        await askContent(ctx); return;
      }
      if (p[1] === "show") { await showCard(ctx, table, id); ctx.wizard = {}; return; }
      if (table === "templates" && p[1] === "use") { await useTemplate(ctx, id); return; }
      if (data === "templates:save" && w.kind === "template" && w.step === "confirm") {
        await lockUser(ctx.db, ctx.userId);
        await accounts.params(ctx.db, ctx.userId); await validateGroups(ctx);
        const templateId = await saveTemplate(ctx); ctx.wizard = {};
        await ctx.reply(t("templates.created")); await showCard(ctx, "templates", templateId); return;
      }
      if (table === "templates" && p[1] === "delete") { await owned(ctx, table, id); await show(ctx, t("templates.delete_confirm"), confirm(`templates:delete_confirm:${id}`, `templates:show:${id}`)); return; }
      if (table === "templates" && p[1] === "delete_confirm") {
        await owned(ctx, table, id); await ctx.db.query("DELETE FROM templates WHERE id=$1 AND user_id=$2", [id, ctx.userId]);
        await ctx.reply(t("templates.deleted")); await listing(ctx, table); return;
      }
      if (p[1] === "edit" && table === "announcements") {
        await editMenu(ctx, id); return;
      }
      if (p[1]?.startsWith("edit_")) {
        if (table === "templates") throw new Failure("NOT_FOUND");
        const record = await owned(ctx, table, id); const field = p[1].slice(5);
        if (!["text", "photo", "contact", "name", "groups", "interval", "window"].includes(field)) throw new Failure("NOT_FOUND");
        ctx.wizard = { editId: id, table, step: `edit_${field}` };
        if (field === "groups") {
          ctx.wizard.groups = (await ctx.db.query("SELECT group_id FROM announcement_groups WHERE announcement_id=$1", [id])).rows.map(g => String(g.group_id));
          await askGroups(ctx);
        } else if (field === "interval") await askInterval(ctx);
        else if (field === "window") await askWindow(ctx);
        else await show(ctx, t(`announcements.${field === "photo" ? "send_ready_photo" : `send_${field}`}`), wizardBack(ctx));
        void record; return;
      }
      if (p[1] === "photos_done" && w.step === "edit_photo" && w.editId && w.table === "announcements") {
        if (!w.photoMessageIds?.length || w.photoMessageIds.length > maxAnnouncementPhotos) throw new Failure("INVALID_CONTENT");
        await lockUser(ctx.db, ctx.userId);
        const record = await owned(ctx, "announcements", w.editId);
        if (record.status === "deleted") throw new Failure("NOT_FOUND");
        if (record.status === "paused") {
          await requireCreationAccess(ctx.db, ctx.userId);
          const count = await one(ctx.db, "SELECT count(*)::int n FROM announcements WHERE user_id=$1 AND status='active'", [ctx.userId]);
          if (count.n >= config.maxAnnouncements) throw new Failure("ANNOUNCEMENT_LIMIT");
        }
        await ctx.db.query(`UPDATE announcements SET photo_file_id=NULL,photo_file_ids='[]',photo_message_ids=$3,
          text=COALESCE($4,text),status='active',updated_at=now() WHERE id=$1 AND user_id=$2`,
          [w.editId, ctx.userId, JSON.stringify(w.photoMessageIds), w.text ?? null]);
        const editId = w.editId; ctx.wizard = {};
        await ctx.reply(t("templates.updated")); await showCard(ctx, "announcements", editId); return;
      }
      if (p[1] === "photos_done" && ["photos", "caption"].includes(w.step ?? "")) {
        if (!w.text || !draftPhotoCount(w)) throw new Failure("INVALID_CONTENT");
        await finishContent(ctx); return;
      }
    }
    if (data === "ann:content_done" && w.kind && w.step === "content") {
      if (!w.text) throw new Failure("INVALID_CONTENT");
      await finishContent(ctx); return;
    }
    if (data === "ann:create:template" && w.kind === "announcement" && w.step === "content") {
      w.step = "template_picker";
      const templates = (await ctx.db.query("SELECT id,text FROM templates WHERE user_id=$1 ORDER BY updated_at DESC", [ctx.userId])).rows;
      const keyboard = new InlineKeyboard();
      for (const row of templates) keyboard.text(row.text.slice(0, 40), `ann:template:${row.id}`).row();
      await show(ctx, t(templates.length ? "announcements.from_template" : "templates.empty"), wizardBack(ctx, keyboard)); return;
    }
    if (p[0] === "ann" && p[1] === "template" && w.kind === "announcement" && ["content", "template_picker"].includes(w.step ?? "")) {
      await useTemplate(ctx, id); return;
    }
    if (p[0] === "ann" && p[1] === "groups_page" && ["groups", "edit_groups"].includes(w.step ?? "")) {
      w.groupPage = Number(id); await askGroups(ctx); return;
    }
    if (p[0] === "ann" && p[1] === "group" && ["groups", "edit_groups"].includes(w.step ?? "")) {
      if (!(await groups.list(ctx.db, ctx.userId)).some(g => String(g.id) === id && g.can_post)) throw new Failure("NOT_FOUND");
      if (!w.groups?.includes(id) && (w.groups?.length ?? 0) >= config.maxGroupsPerAnnouncement) throw new Failure("ANNOUNCEMENT_GROUP_LIMIT");
      w.groups = w.groups?.includes(id) ? w.groups.filter(g => g !== id) : [...w.groups ?? [], id]; await askGroups(ctx); return;
    }
    if (data === "ann:groups_done" && ["groups", "edit_groups"].includes(w.step ?? "")) {
      if (w.step === "edit_groups") await lockUser(ctx.db, ctx.userId);
      await validateGroups(ctx);
      if (w.step === "edit_groups") {
        await owned(ctx, "announcements", w.editId!);
        await ctx.db.query("DELETE FROM announcement_groups WHERE announcement_id=$1", [w.editId]);
        for (const group of w.groups!) await ctx.db.query("INSERT INTO announcement_groups(announcement_id,group_id) VALUES($1,$2)", [w.editId, group]);
        const editId = w.editId!; ctx.wizard = {}; await showCard(ctx, "announcements", editId);
      } else await askInterval(ctx);
      return;
    }
    if (p[0] === "ann" && p[1] === "interval" && ["interval", "edit_interval"].includes(w.step ?? "")) {
      const interval = Number(id); if (!intervals.includes(interval)) throw new Failure("INVALID_INTERVAL");
      if (w.step === "edit_interval") {
        await lockUser(ctx.db, ctx.userId);
        await owned(ctx, "announcements", w.editId!);
        await ctx.db.query("UPDATE announcements SET interval_minutes=$3,updated_at=now() WHERE id=$1 AND user_id=$2", [w.editId, ctx.userId, interval]);
        const editId = w.editId!; ctx.wizard = {}; await showCard(ctx, "announcements", editId);
      } else { w.interval = interval; await askWindow(ctx); }
      return;
    }
    if (p[0] === "ann" && p[1] === "clock" && ["window_start", "window_end"].includes(w.step ?? "")) {
      if (p[2] === "back") { await askClock(ctx, "start"); return; }
      if (w.step !== `window_${p[2]}`) throw new Failure("NOT_FOUND");
      if (p[3] === "manual") { w.clockManual = true; await show(ctx, t("announcements.clock_input"), wizardBack(ctx, button("announcements.window_all", "ann:window:all"))); return; }
      if (!/^\d{1,4}$/.test(p[3] ?? "")) throw new Failure("INVALID_SENDING_WINDOW");
      await chooseClock(ctx, Number(p[3])); return;
    }
    if (p[0] === "ann" && p[1] === "window" && ["window", "edit_window", "window_start", "window_end"].includes(w.step ?? "")) {
      if (p[2] === "custom") { w.clockManual = true; await show(ctx, t("announcements.window_input"), wizardBack(ctx, button("announcements.window_all", "ann:window:all"))); return; }
      if (p[2] === "all") await saveWindow(ctx, { send_start_minute: null, send_end_minute: null });
      else {
        if (p.length !== 4 || !/^\d{1,4}$/.test(p[2]) || !/^\d{1,4}$/.test(p[3])) throw new Failure("INVALID_SENDING_WINDOW");
        await saveWindow(ctx, { send_start_minute: Number(p[2]), send_end_minute: Number(p[3]) });
      }
      return;
    }
    if (p[0] === "ann" && p[1] === "save_template" && w.step === "save_template" && ["yes", "no"].includes(p[2])) {
      w.saveTemplate = !w.fromTemplate && p[2] === "yes";
      if (w.mode) await showConfirmation(ctx); else await askFirstRun(ctx);
      return;
    }
    if (p[0] === "ann" && p[1] === "first" && w.step === "first_run" && ["immediate", "scheduled"].includes(p[2])) {
      w.mode = p[2];
      if (w.kind === "template" || w.fromTemplate || w.saveTemplate !== undefined) await showConfirmation(ctx);
      else await askSaveTemplate(ctx);
      return;
    }
    if (data === "ann:cancel") { ctx.wizard = {}; await show(ctx, t("common.cancel")); return; }
    if (data === "ann:confirm" && w.step === "confirm" && w.kind === "announcement") {
      await lockUser(ctx.db, ctx.userId);
      await accounts.params(ctx.db, ctx.userId); await validateGroups(ctx);
      const count = await one(ctx.db, "SELECT count(*)::int n FROM announcements WHERE user_id=$1 AND status='active'", [ctx.userId]);
      if (count.n >= config.maxAnnouncements) throw new Failure("ANNOUNCEMENT_LIMIT");
      if (!validSendingWindow(w)) throw new Failure("INVALID_SENDING_WINDOW");
      validateContent(w);
      await requireCreationAccess(ctx.db, ctx.userId, true);
      await draftSources(ctx);
      const next = nextSendingTime(new Date(Date.now() + (w.mode === "immediate" ? 0 : w.interval! * 60_000)), w);
      const announcement = await one(ctx.db, `INSERT INTO announcements(user_id,text,photo_file_id,photo_file_ids,interval_minutes,first_run_mode,next_run_at,send_start_minute,send_end_minute,contact_phone,contact_telegram,contact_name,photo_message_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [ctx.userId, w.text, null, JSON.stringify([]), w.interval, w.mode,
        next, w.send_start_minute ?? null, w.send_end_minute ?? null, w.contact_phone ?? null, w.contact_telegram ?? null, w.contact_name ?? null, JSON.stringify(w.photoMessageIds ?? [])]);
      for (const group of w.groups!) await ctx.db.query("INSERT INTO announcement_groups(announcement_id,group_id) VALUES($1,$2)", [announcement.id, group]);
      if (w.saveTemplate && !w.fromTemplate) await saveTemplate(ctx);
      ctx.sendNow = w.mode === "immediate"; ctx.wizard = {};
      await ctx.reply(`${t("announcements.created")}\n${t("announcements.window_label")}: ${windowDescription(w)}`, { reply_markup: mainKeyboard() }); return;
    }
    if (p[0] === "ann" && p[1] === "delete_request") {
      await owned(ctx, "announcements", id); await show(ctx, t("announcements.delete_confirm"), confirm(`ann:delete_confirm:${id}`, `ann:show:${id}`)); return;
    }
    if (p[0] === "ann" && p[1] === "delete_confirm") {
      await lockUser(ctx.db, ctx.userId);
      await owned(ctx, "announcements", id);
      await ctx.db.query("UPDATE announcements SET status='deleted',next_run_at=NULL WHERE id=$1 AND user_id=$2", [id, ctx.userId]);
      await show(ctx, t("announcements.delete_sent_prompt"), confirm(`ann:delete_messages:yes:${id}`, `ann:delete_messages:no:${id}`)); return;
    }
    if (p[0] === "ann" && p[1] === "delete_messages" && ["yes", "no"].includes(p[2])) {
      await lockUser(ctx.db, ctx.userId);
      const annId = idAt(p, 3); const record = await owned(ctx, "announcements", annId);
      if (record.status !== "deleted") throw new Failure("NOT_FOUND");
      const failures = p[2] === "yes" ? await delivery.removePublished(ctx.db, ctx.userId, annId) : 0;
      await ctx.db.query("DELETE FROM announcements WHERE id=$1 AND user_id=$2", [annId, ctx.userId]);
      await ctx.reply(t("announcements.deleted"));
      if (failures) await ctx.reply(t("delivery.cleanup_partial", { count: failures }));
      await listing(ctx, "announcements"); return;
    }
    await ctx.reply(t("common.not_found"));
  });

  async function validateGroups(ctx: Ctx) {
    const selected = ctx.wizard.groups;
    if ((selected?.length ?? 0) > config.maxGroupsPerAnnouncement) throw new Failure("ANNOUNCEMENT_GROUP_LIMIT");
    const available = new Set((await groups.list(ctx.db, ctx.userId)).filter(g => g.can_post).map(g => String(g.id)));
    if (!selected?.length || selected.some(g => !available.has(g))) throw new Failure(ctx.wizard.fromTemplate ? "TEMPLATE_GROUPS_UNAVAILABLE" : "GROUP_REQUIRED");
  }
  async function candidatePage(ctx: Ctx, page: number) {
    const candidates = ctx.wizard.candidates ?? [];
    if (!Number.isSafeInteger(page) || page < 0 || page > Math.floor(candidates.length / 10)) throw new Failure("NOT_FOUND");
    const keyboard = new InlineKeyboard();
    candidates.slice(page * 10, page * 10 + 10).forEach((g, i) => {
      if (g.canPost) keyboard.text(g.title.slice(0, 45), `groups:connect:${page * 10 + i}`).row();
    });
    if (page > 0) keyboard.text("←", `groups:page:${page - 1}`);
    if ((page + 1) * 10 < candidates.length) keyboard.text("→", `groups:page:${page + 1}`);
    keyboard.row().text(t("groups.refresh"), "groups:refresh").row().text(t("common.back"), "groups:list");
    const seconds = Math.max(0, Math.ceil(((ctx.wizard.candidatesRetryAt ?? 0) - Date.now()) / 1000));
    const notice = seconds ? t("groups.cached_rate_limited", { seconds }) : ctx.wizard.candidatesCached ? t("groups.cached_list") : "";
    await show(ctx, [t(candidates.length ? "groups.select_known" : "groups.connect_instruction"), notice].filter(Boolean).join("\n\n"), keyboard);
  }

  bot.on("message", async ctx => {
    const message = ctx.message; const w = ctx.wizard;
    if (message.text?.startsWith("/")) { await ctx.reply(t("commands.unknown")); return; }
    if (w.support || await support.isReply(ctx.db, ctx.userId, message.reply_to_message?.message_id)) {
      const saved = await support.receive(ctx.db, ctx.userId, message);
      ctx.notifySupport = !!saved;
      await ctx.reply(t("support.received"), { reply_markup: button("support.done", "support:done") }); return;
    }
    if (["window_start", "window_end"].includes(w.step ?? "") && message.text && !parseSendingWindow(message.text)) {
      const minute = parseClockTime(message.text, w.step === "window_end");
      if (minute === undefined) { await ctx.reply(t("announcements.clock_invalid")); return; }
      await chooseClock(ctx, minute); return;
    }
    if (["window", "edit_window", "window_start", "window_end"].includes(w.step ?? "")) {
      const window = message.text && parseSendingWindow(message.text);
      if (!window) { await ctx.reply(t("announcements.window_invalid")); return; }
      await saveWindow(ctx, window); return;
    }
    if (w.step?.startsWith("edit_") && w.editId && w.table === "announcements") {
      await lockUser(ctx.db, ctx.userId);
      await owned(ctx, w.table, w.editId);
      const field = w.step.slice(5);
      if (field === "photo" && message.photo) {
        if (!await acceptPhoto(ctx)) return;
        if (!w.text && message.caption) w.text = message.caption;
        await ctx.reply(t("announcements.photos_continue"), { reply_markup: wizardBack(ctx, button("common.done", "ann:photos_done")) }); return;
      } else if (["text", "contact", "name"].includes(field) && message.text && message.text.length <= (field === "text" ? 4096 : 255)) {
        if (field === "contact") {
          const isTelegram = message.text.startsWith("@") || message.text.includes("t.me/");
          if (!isTelegram && message.text.length > 32) throw new Failure("INVALID_CONTACT");
          await ctx.db.query(`UPDATE ${w.table} SET contact_phone=$3,contact_telegram=$4,updated_at=now() WHERE id=$1 AND user_id=$2`, [w.editId, ctx.userId, isTelegram ? null : message.text, isTelegram ? message.text : null]);
        } else await ctx.db.query(`UPDATE ${w.table} SET ${field === "name" ? "contact_name" : "text"}=$3,updated_at=now() WHERE id=$1 AND user_id=$2`, [w.editId, ctx.userId, message.text]);
      } else { await ctx.reply(t(field === "photo" ? "templates.photo_required" : "common.error")); return; }
      const table = w.table, editId = w.editId; ctx.wizard = {}; await ctx.reply(t("templates.updated")); await showCard(ctx, table, editId); return;
    }
    if (w.kind && ["content", "photos", "caption"].includes(w.step ?? "")) {
      if (message.photo) {
        if (!await acceptPhoto(ctx)) return;
        if (!w.text && message.caption) w.text = message.caption;
        w.step = w.text ? "photos" : "caption";
        await ctx.reply(t(w.text ? "announcements.photos_continue" : "announcements.photo_without_caption"),
          { reply_markup: wizardBack(ctx, button("common.done", `${w.kind === "template" ? "templates" : "ann"}:photos_done`)) }); return;
      }
      if (message.text && message.text.length <= 4096) {
        w.text = message.text;
        if (draftPhotoCount(w)) {
          w.step = "photos"; await ctx.reply(t("announcements.photos_continue"), { reply_markup: wizardBack(ctx, button("common.done", `${w.kind === "template" ? "templates" : "ann"}:photos_done`)) });
        } else await finishContent(ctx);
        return;
      }
    }
    await ctx.reply(t("start.choose_section"), { reply_markup: mainKeyboard() });
  });
  return bot;
}
