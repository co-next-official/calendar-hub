// Calendar Hub UI. Talks to the Worker API (/api/*) with the session cookie.
const $ = (id) => document.getElementById(id);
const HOUR = 56;
const CATEGORY = { work: "仕事", personal: "個人", team: "チーム" };
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo";
const today = startOfDay(new Date());

const state = {
  view: "month",
  selected: new Date(today),
  anchor: new Date(today),
  events: [], // API rows
  range: null, // { from, to } currently loaded
  editing: null,
  activeId: null,
  busy: false,
};

// ---------- date helpers ----------
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function keyDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function parseKey(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function hhmm(d) { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
function fmt(d, opt = { year: "numeric", month: "long", day: "numeric", weekday: "short" }) { return new Intl.DateTimeFormat("ja-JP", opt).format(d); }
function make(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }

function visibleDates() {
  if (state.view === "month") {
    const first = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1);
    const start = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }
  if (state.view === "week") {
    const start = addDays(startOfDay(state.anchor), -state.anchor.getDay());
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }
  return [startOfDay(state.selected)];
}

/** Splits an event into per-local-day pieces: { e, allDay, startMin, endMin }. */
function piecesOn(day) {
  const key = keyDate(day);
  const dayStart = day.getTime(), dayEnd = addDays(day, 1).getTime();
  const q = $("search").value.trim().toLocaleLowerCase();
  const out = [];
  for (const e of state.events) {
    if (q && !e.title.toLocaleLowerCase().includes(q)) continue;
    if (e.all_day) {
      if (e.start_date <= key && key < e.end_date) out.push({ e, allDay: true });
      continue;
    }
    const s = Date.parse(e.start_at), en = Date.parse(e.end_at);
    if (s < dayEnd && en > dayStart) {
      out.push({ e, allDay: false, startMin: Math.max(0, (s - dayStart) / 60000), endMin: Math.min(1440, (en - dayStart) / 60000) });
    }
  }
  return out.sort((a, b) => (a.allDay === b.allDay ? (a.startMin ?? 0) - (b.startMin ?? 0) : a.allDay ? -1 : 1));
}

function timeLabel(e) {
  if (e.all_day) {
    const days = (parseKey(e.end_date) - parseKey(e.start_date)) / 86400000;
    return days > 1 ? `終日（${fmt(parseKey(e.start_date), { month: "short", day: "numeric" })}〜${fmt(addDays(parseKey(e.end_date), -1), { month: "short", day: "numeric" })}）` : "終日";
  }
  const s = new Date(e.start_at), en = new Date(e.end_at);
  return keyDate(s) === keyDate(en) ? `${hhmm(s)}–${hhmm(en)}` : `${fmt(s, { month: "short", day: "numeric" })} ${hhmm(s)} – ${fmt(en, { month: "short", day: "numeric" })} ${hhmm(en)}`;
}
const minLabel = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;

// ---------- API ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showGate(); throw Object.assign(new Error("ログインが必要です"), { status: 401 }); }
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

async function loadRange(force = false) {
  const dates = visibleDates();
  const from = keyDate(dates[0]), to = keyDate(addDays(dates[dates.length - 1], 1));
  if (!force && state.range && state.range.from === from && state.range.to === to) return;
  state.range = { from, to };
  try {
    const { events } = await api("GET", `/api/events?from=${from}&to=${to}`);
    if (state.range.from !== from || state.range.to !== to) return; // superseded by a newer navigation
    state.events = events;
    setStatus("");
  } catch (err) {
    if (err.status !== 401) setStatus("予定を読み込めませんでした。通信状態を確認して再読み込みしてください。");
  }
  render();
}

// ---------- rendering ----------
function eventButton(p, extra = "") {
  const b = make("button", `event ${p.e.category}${p.allDay ? " all-day" : ""}${p.e.is_owner === false ? " shared" : ""}${p.e.source === "google" ? " from-google" : ""}${extra}`);
  b.type = "button";
  b.title = `${timeLabel(p.e)} ${p.e.title}`;
  b.addEventListener("click", (ev) => { ev.stopPropagation(); showDetail(p.e.id); });
  return b;
}

function layoutTimed(container, pieces, inset) {
  const lanes = [], placed = [];
  for (const p of pieces) {
    const visualEnd = Math.max(p.endMin, p.startMin + 24);
    let lane = lanes.findIndex((items) => items.every((x) => x.end <= p.startMin || x.start >= visualEnd));
    if (lane < 0) { lane = lanes.length; lanes.push([]); }
    lanes[lane].push({ start: p.startMin, end: visualEnd });
    placed.push({ p, lane });
  }
  const count = Math.max(1, lanes.length);
  for (const { p, lane } of placed) {
    const card = eventButton(p, inset > 2 ? " timeline-event" : " week-event");
    card.style.top = `${(p.startMin / 60) * HOUR + 2}px`;
    card.style.height = `${Math.max(22, ((p.endMin - p.startMin) / 60) * HOUR - 3)}px`;
    card.style.left = `calc(${lane} * ${100 / count}% + ${inset}px)`;
    card.style.width = `calc(${100 / count}% - ${inset * 2}px)`;
    card.append(make("span", "day-event-title", p.e.title), make("span", "day-event-time", `${minLabel(p.startMin)}–${minLabel(p.endMin)}`));
    container.append(card);
  }
}

function renderMonth(daysEl, dates) {
  const month = state.anchor.getMonth();
  for (const d of dates) {
    const cell = make("div", "day");
    if (d.getMonth() !== month) cell.classList.add("outside");
    if (keyDate(d) === keyDate(today)) cell.classList.add("today");
    if (keyDate(d) === keyDate(state.selected)) cell.classList.add("selected");
    cell.tabIndex = 0;
    cell.setAttribute("role", "button");
    cell.setAttribute("aria-label", fmt(d));
    cell.addEventListener("click", () => { state.selected = new Date(d); render(); });
    cell.addEventListener("dblclick", () => openForm(null, d));
    cell.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); state.selected = new Date(d); render(); } });
    cell.append(make("div", "num", String(d.getDate())));
    const list = piecesOn(d);
    for (const p of list.slice(0, 3)) {
      const b = eventButton(p);
      b.textContent = `${p.allDay ? "" : minLabel(p.startMin) + "　"}${p.e.title}`;
      cell.append(b);
    }
    if (list.length > 3) cell.append(make("div", "more", `他 ${list.length - 3} 件`));
    daysEl.append(cell);
  }
}

function renderWeek(daysEl, dates) {
  const wrap = make("div", "week-view"), scroller = make("div", "week-scroll"), grid = make("div", "week-grid");
  grid.append(make("div", "week-grid-head axis", "時間"));
  for (const d of dates) {
    const head = make("div", "week-grid-head", `${fmt(d, { weekday: "short" })} ${d.getDate()}`);
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.addEventListener("click", () => { state.selected = new Date(d); state.anchor = new Date(d); state.view = "day"; refresh(); });
    grid.append(head);
  }
  grid.append(make("div", "week-allday axis", "終日"));
  for (const d of dates) {
    const slot = make("div", "week-allday");
    for (const p of piecesOn(d).filter((x) => x.allDay)) { const b = eventButton(p); b.textContent = p.e.title; slot.append(b); }
    grid.append(slot);
  }
  const axis = make("div", "week-time-axis");
  for (let h = 0; h < 24; h++) { const hr = make("div", "week-hour"); hr.append(make("span", "", `${String(h).padStart(2, "0")}:00`)); axis.append(hr); }
  grid.append(axis);
  for (const d of dates) {
    const col = make("div", "week-column");
    col.addEventListener("click", () => { state.selected = new Date(d); render(); });
    col.addEventListener("dblclick", (ev) => openForm(null, d, Math.min(22, Math.floor(ev.offsetY / HOUR))));
    layoutTimed(col, piecesOn(d).filter((x) => !x.allDay), 2);
    grid.append(col);
  }
  scroller.append(grid);
  wrap.append(scroller);
  daysEl.append(wrap);
  scroller.scrollTop = 8 * HOUR;
}

function renderDay(daysEl, d) {
  const cell = make("div", "day selected");
  const layout = make("div", "day-view");
  layout.append(make("div", "day-date", fmt(d, { year: "numeric", month: "long", day: "numeric", weekday: "long" })));
  const list = piecesOn(d), allDay = list.filter((p) => p.allDay), timed = list.filter((p) => !p.allDay);
  const all = make("section", "all-day-section");
  all.append(make("div", "day-section-title", "終日"));
  const items = make("div", "all-day-items");
  if (allDay.length) for (const p of allDay) { const b = eventButton(p, " day-event"); b.append(make("span", "day-event-title", p.e.title)); items.append(b); }
  else items.append(make("div", "empty", "終日の予定はありません"));
  all.append(items);
  layout.append(all);
  if (!list.length) layout.append(make("div", "day-empty", "この日の予定はありません。ダブルクリックか「＋ 予定を作成」で追加できます。"));
  const timeline = make("div", "timeline");
  for (let h = 0; h < 24; h++) { const row = make("div", "hour-row"); row.append(make("div", "hour-label", `${String(h).padStart(2, "0")}:00`)); timeline.append(row); }
  timeline.addEventListener("dblclick", (ev) => { if (ev.target === timeline || ev.target.classList.contains("hour-row")) openForm(null, d, Math.min(22, Math.floor((ev.offsetY + (ev.target === timeline ? 0 : ev.target.offsetTop)) / HOUR))); });
  layoutTimed(timeline, timed, 4);
  const scroll = make("div", "timeline-scroll");
  scroll.append(timeline);
  layout.append(scroll);
  cell.append(layout);
  daysEl.append(cell);
  scroll.scrollTop = Math.max(0, (timed.length ? timed[0].startMin / 60 - 2 : 8)) * HOUR;
}

function renderAgenda() {
  $("agendaDate").textContent = fmt(state.selected);
  const rows = $("agendaRows");
  rows.replaceChildren();
  const list = piecesOn(state.selected);
  if (!list.length) rows.append(make("div", "empty", "この日の予定はありません"));
  for (const p of list) {
    const row = make("div", "agenda-row");
    row.append(make("div", "time", p.allDay ? "終日" : `${minLabel(p.startMin)}–${minLabel(p.endMin)}`));
    const info = make("div");
    info.append(make("strong", "", p.e.title), make("small", "", CATEGORY[p.e.category]));
    row.append(info);
    row.addEventListener("click", () => showDetail(p.e.id));
    rows.append(row);
  }
}

function render() {
  const dates = visibleDates();
  const calendar = $("calendar");
  const title =
    state.view === "month" ? fmt(state.anchor, { year: "numeric", month: "long" })
    : state.view === "week" ? `${fmt(dates[0], { month: "short", day: "numeric" })} 〜 ${fmt(dates[6], { month: "short", day: "numeric", year: "numeric" })}`
    : fmt(state.selected);
  $("headingPeriod").textContent = state.view === "day" ? fmt(state.selected, { year: "numeric", month: "long" }) : title;
  $("period").textContent = title;
  calendar.classList.toggle("view-day", state.view === "day");
  calendar.classList.toggle("view-week", state.view === "week");
  calendar.closest(".workspace").classList.toggle("workspace-day", state.view === "day");
  document.querySelectorAll("[data-view]").forEach((b) => { b.classList.toggle("active", b.dataset.view === state.view); b.setAttribute("aria-pressed", String(b.dataset.view === state.view)); });
  const daysEl = $("days");
  daysEl.replaceChildren();
  if (state.view === "month") renderMonth(daysEl, dates);
  else if (state.view === "week") renderWeek(daysEl, dates);
  else renderDay(daysEl, dates[0]);
  renderAgenda();
}

function refresh() { render(); loadRange(); }

function move(delta) {
  if (state.view === "month") state.anchor = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + delta, 1);
  else if (state.view === "week") { state.anchor = addDays(state.anchor, 7 * delta); state.selected = addDays(state.selected, 7 * delta); }
  else { state.selected = addDays(state.selected, delta); state.anchor = new Date(state.selected); }
  refresh();
}

// ---------- form / detail ----------
function toggleAllDay() {
  const allDay = $("allDay").checked;
  $("timeFields").hidden = allDay;
  $("timeHint").hidden = allDay;
}

function openForm(id = null, date = state.selected, hour = 10) {
  const e = id ? state.events.find((x) => x.id === id) : null;
  if (id && !e) return;
  state.editing = e;
  $("form").reset();
  $("formHeading").textContent = e ? "予定を編集" : "予定を作成";
  $("title").value = e?.title ?? "";
  $("category").value = e?.category ?? "personal";
  $("notes").value = e?.notes ?? "";
  $("allDay").checked = e ? e.all_day : false;
  const share = sharingOf(e);
  $("visibility").value = share.visibility;
  $("participants").value = share.participants.join("\n");
  refreshGroupSelect();
  if (share.group_id) $("groupSelect").value = share.group_id;
  $("busyOnly").checked = share.busy_only;
  toggleShare();
  if (e && !e.all_day) {
    const s = new Date(e.start_at), en = new Date(e.end_at);
    $("date").value = keyDate(s);
    $("start").value = hhmm(s);
    $("end").value = keyDate(s) === keyDate(en) ? hhmm(en) : "23:59";
  } else {
    $("date").value = e ? e.start_date : keyDate(date);
    $("start").value = `${String(hour).padStart(2, "0")}:00`;
    $("end").value = `${String(hour + 1).padStart(2, "0")}:00`;
  }
  toggleAllDay();
  $("modal").classList.add("open");
  $("title").focus();
}
function closeForm() { $("modal").classList.remove("open"); state.editing = null; }

function payloadFromForm() {
  const title = $("title").value.trim(), date = $("date").value, allDay = $("allDay").checked;
  const body = { title, category: $("category").value, notes: $("notes").value, timezone: TZ, all_day: allDay };
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("タイトルと日付を入力してください");
  if (allDay) {
    const e = state.editing;
    const span = e?.all_day ? Math.round((parseKey(e.end_date) - parseKey(e.start_date)) / 86400000) : 1;
    body.start_date = date;
    body.end_date = keyDate(addDays(parseKey(date), span));
  } else {
    const start = $("start").value, end = $("end").value;
    if (!start || !end || end <= start) throw new Error("終了は同じ日の開始より後にしてください");
    body.start_at = new Date(`${date}T${start}`).toISOString();
    body.end_at = new Date(`${date}T${end}`).toISOString();
  }
  return body;
}

async function save(ev) {
  ev.preventDefault();
  if (state.busy) return;
  let body;
  try { body = payloadFromForm(); } catch (err) { return toast(err.message); }
  state.busy = true;
  $("save").disabled = true;
  const editing = state.editing;
  try {
    let saved = editing ? await api("PATCH", `/api/events/${editing.id}`, { ...body, version: editing.version }) : await api("POST", "/api/events", body);
    const share = sharingFromForm();
    if (JSON.stringify(share) !== JSON.stringify(sharingOf(editing))) {
      try { saved = await api("PUT", `/api/events/${saved.id}/sharing`, share); }
      catch (err) { toast(`予定は保存しましたが共有の設定に失敗しました（${err.message}）`); }
    }
    state.events = editing ? state.events.map((x) => (x.id === saved.id ? saved : x)) : [...state.events, saved];
    state.selected = saved.all_day ? parseKey(saved.start_date) : startOfDay(new Date(saved.start_at));
    state.anchor = new Date(state.selected);
    closeForm();
    refresh();
    toast(saved.conflicts?.length ? `保存しました。「${saved.conflicts[0].title}」${saved.conflicts.length > 1 ? `ほか${saved.conflicts.length - 1}件` : ""}と時間が重なっています` : editing ? "予定を更新しました" : "予定を追加しました");
  } catch (err) {
    if (err.status === 409) { toast("別の画面で先に更新されていました。最新の内容を読み込みます"); closeForm(); loadRange(true); }
    else if (err.status !== 401) toast(`保存できませんでした（${err.message}）`);
  } finally {
    state.busy = false;
    $("save").disabled = false;
  }
}

function showDetail(id) {
  const e = state.events.find((x) => x.id === id);
  if (!e) return;
  state.activeId = id;
  $("detailTitle").textContent = e.title;
  const day = e.all_day ? parseKey(e.start_date) : new Date(e.start_at);
  const who = e.is_owner === false ? `${e.owner_name} さんの予定` : e.source === "google" ? "Googleカレンダー（読み取り専用）" : CATEGORY[e.category];
  $("detailMeta").textContent = [`${fmt(day, { year: "numeric", month: "long", day: "numeric", weekday: "long" })} · ${timeLabel(e)} · ${who}`, e.notes].filter(Boolean).join("\n\n");
  $("detailEdit").hidden = $("detailDelete").hidden = e.is_owner === false || e.source === "google";
  renderDetailExtra(e);
  $("detail").classList.add("open");
  $("detail").setAttribute("aria-hidden", "false");
}
const RESPONSE = { yes: "参加", no: "不参加", maybe: "未定", pending: "未回答" };
const VISIBILITY = { private: "自分だけ", participants: "指定した人に共有", group: "グループに共有" };

function renderDetailExtra(e) {
  const box = $("detailExtra");
  box.replaceChildren();
  if (e.is_owner !== false && e.visibility !== "private") {
    const g = state.groups.find((x) => x.id === e.group_id);
    box.append(make("div", "participant-list", `${VISIBILITY[e.visibility]}${g ? `（${g.name}）` : ""}${e.busy_only ? " · 相手には「予定あり」のみ" : ""}`));
  }
  if (e.participants?.length) {
    box.append(make("div", "participant-list", e.participants.map((p) => `${p.name || p.email}：${RESPONSE[p.response]}`).join("　")));
  }
  const row = make("div", "detail-extra-row");
  if (e.my_response !== null && e.my_response !== undefined) {
    for (const r of ["yes", "maybe", "no"]) {
      const b = make("button", e.my_response === r ? "on" : "", RESPONSE[r]);
      b.type = "button";
      b.onclick = async () => {
        const updated = await api("POST", `/api/events/${e.id}/response`, { response: r });
        state.events = state.events.map((x) => (x.id === updated.id ? updated : x));
        showDetail(e.id);
      };
      row.append(b);
    }
  }
  if (e.is_owner !== false) {
    const link = make("button", "", "ゲスト招待リンク");
    link.type = "button";
    link.onclick = async () => {
      try {
        const inv = await api("POST", `/api/events/${e.id}/invites`, { expires_in_days: 14 });
        await navigator.clipboard.writeText(inv.url).catch(() => {});
        prompt("招待リンク（14日間有効。コピーして送ってください）", inv.url);
      } catch (err) { toast(`作成できませんでした（${err.message}）`); }
    };
    row.append(link);
  }
  const ics = make("a", "", "カレンダーアプリに追加（.ics）");
  ics.href = `/api/events/${e.id}/ics`;
  row.append(ics);
  box.append(row);
}

function closeDetail() { $("detail").classList.remove("open"); $("detail").setAttribute("aria-hidden", "true"); state.activeId = null; }

async function removeActive() {
  const e = state.events.find((x) => x.id === state.activeId);
  if (!e || state.busy || !confirm(`「${e.title}」を削除しますか？`)) return;
  state.busy = true;
  try {
    await api("DELETE", `/api/events/${e.id}`);
    state.events = state.events.filter((x) => x.id !== e.id);
    closeDetail();
    render();
    toast("予定を削除しました");
  } catch (err) {
    if (err.status === 404) { closeDetail(); loadRange(true); }
    else if (err.status !== 401) toast("削除できませんでした");
  } finally { state.busy = false; }
}

// ---------- import from the old ChatGPT Sites version ----------
async function importLegacy(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast("JSONとして読めませんでした"); }
  const events = Array.isArray(data) ? data : data?.events;
  if (!Array.isArray(events)) return toast("events 配列が見つかりません");
  if (!confirm(`${events.length}件の予定を取り込みますか？（同じ予定を2回取り込んでも重複しません）`)) return;
  try {
    const r = await api("POST", "/api/import/calendar-hub", { events, timezone: TZ });
    toast(`取り込み ${r.created}件 / 取り込み済み ${r.skipped}件${r.failed.length ? ` / 失敗 ${r.failed.length}件` : ""}`);
    loadRange(true);
  } catch (err) {
    if (err.status !== 401) toast(`取り込めませんでした（${err.message}）`);
  }
}

// ---------- groups ----------
state.groups = [];

async function loadGroups() {
  try {
    const { groups } = await api("GET", "/api/groups");
    state.groups = groups;
    const list = $("groupList");
    list.replaceChildren();
    if (!groups.length) list.textContent = "まだありません";
    for (const g of groups) list.append(make("div", "side-group", `👥 ${g.name}`));
    refreshGroupSelect();
  } catch { /* shown elsewhere */ }
}

async function loadInvitations() {
  const box = $("invitations");
  try {
    const { invitations } = await api("GET", "/api/groups/invitations");
    box.hidden = !invitations.length;
    box.replaceChildren();
    for (const inv of invitations) {
      const row = make("div", "invite-row");
      row.append(make("span", "", `${inv.invited_by ? inv.invited_by + " さんから" : ""}グループ「${inv.group_name}」に招待されています。参加すると、グループのメンバーにあなたの空き時間（予定の中身は除く）が見えるようになります。`));
      const yes = make("button", "", "参加する"), no = make("button", "", "断る");
      yes.onclick = async () => { await api("POST", `/api/groups/${inv.group_id}/accept`); toast("参加しました"); loadInvitations(); loadGroups(); };
      no.onclick = async () => { await api("POST", `/api/groups/${inv.group_id}/decline`); loadInvitations(); };
      row.append(yes, no);
      box.append(row);
    }
  } catch { box.hidden = true; }
}

async function renderGroupDetails() {
  const wrap = $("groupDetails");
  wrap.replaceChildren();
  for (const g of state.groups) {
    let detail;
    try { detail = await api("GET", `/api/groups/${g.id}`); } catch { continue; }
    const card = make("div", "group-card");
    const h = make("h3", "", detail.name);
    if (detail.is_owner) {
      const del = make("button", "", "グループを削除");
      del.onclick = async () => { if (!confirm(`「${detail.name}」を削除しますか？`)) return; await api("DELETE", `/api/groups/${g.id}`); await loadGroups(); renderGroupDetails(); };
      h.append(del);
    }
    card.append(h);
    for (const m of detail.members) {
      const row = make("div", "member-row");
      const info = make("div");
      info.append(make("span", "", m.name || m.email), make("small", "", `  ${m.role === "owner" ? "オーナー" : m.status === "invited" ? "招待中" : "メンバー"}${m.name ? " · " + m.email : ""}`));
      row.append(info);
      if (m.role !== "owner" && (detail.is_owner || m.is_me)) {
        const btn = make("button", "", m.is_me ? "抜ける" : m.status === "invited" ? "招待を取り消す" : "外す");
        btn.onclick = async () => {
          if (!confirm(m.is_me ? "このグループから抜けますか？" : `${m.email} を外しますか？`)) return;
          await api("DELETE", `/api/groups/${g.id}/members/${m.id}`);
          await loadGroups();
          renderGroupDetails();
        };
        row.append(btn);
      }
      card.append(row);
    }
    if (detail.is_owner) {
      const inviteRow = make("div", "invite-row");
      const input = make("input");
      input.type = "email";
      input.placeholder = "招待する人のGoogleアカウントのメール";
      const btn = make("button", "", "招待");
      btn.onclick = async () => {
        try { await api("POST", `/api/groups/${g.id}/members`, { email: input.value }); toast("招待しました。相手がログインすると承諾できます"); renderGroupDetails(); }
        catch (err) { toast(err.message === "already_member" ? "すでに招待済みです" : err.message === "invalid_email" ? "メールアドレスを確認してください" : "招待できませんでした"); }
      };
      inviteRow.append(input, btn);
      card.append(inviteRow);
    }
    wrap.append(card);
  }
}

async function createGroup() {
  const name = $("groupName").value.trim();
  if (!name) return toast("グループ名を入力してください");
  try { await api("POST", "/api/groups", { name }); $("groupName").value = ""; await loadGroups(); renderGroupDetails(); }
  catch { toast("作成できませんでした"); }
}

function refreshGroupSelect() {
  const sel = $("groupSelect");
  const current = sel.value;
  sel.replaceChildren(...state.groups.map((g) => { const o = make("option", "", g.name); o.value = g.id; return o; }));
  if (current) sel.value = current;
}

function toggleShare() {
  const v = $("visibility").value;
  $("participantsField").hidden = v !== "participants";
  $("groupField").hidden = v !== "group";
  $("busyOnlyField").hidden = v === "private";
  if (v === "group" && !state.groups.length) toast("先にサイドバーの「グループを管理」でグループを作ってください");
}

function sharingFromForm() {
  const visibility = $("visibility").value;
  const participants = $("participants").value.split(/[\s,、]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  return { visibility, participants: visibility === "participants" ? participants : [], group_id: visibility === "group" ? $("groupSelect").value : undefined, busy_only: visibility !== "private" && $("busyOnly").checked };
}

function sharingOf(e) {
  return {
    visibility: e?.visibility ?? "private",
    participants: (e?.participants ?? []).filter((p) => !p.guest).map((p) => p.email),
    group_id: e?.visibility === "group" ? e.group_id : undefined,
    busy_only: (e?.visibility ?? "private") !== "private" && Boolean(e?.busy_only),
  };
}

// ---------- availability ----------
function openAvailability() {
  const sel = $("availGroup");
  sel.replaceChildren(make("option", "", "自分だけ"), ...state.groups.map((g) => { const o = make("option", "", g.name); o.value = g.id; return o; }));
  sel.options[0].value = "";
  if (state.groups[0]) sel.value = state.groups[0].id;
  $("availFrom").value = keyDate(today);
  $("availResults").replaceChildren();
  $("availModal").classList.add("open");
}

async function searchAvailability() {
  const from = $("availFrom").value;
  if (!from) return toast("開始日を選んでください");
  const to = keyDate(addDays(parseKey(from), Number($("availDays").value)));
  const params = new URLSearchParams({ from, to, duration: $("availDuration").value, day_start: $("availStart").value, day_end: $("availEnd").value, timezone: TZ });
  if ($("availGroup").value) params.set("group_id", $("availGroup").value);
  if ($("availAllDay").checked) params.set("include_all_day", "true");
  const box = $("availResults");
  box.replaceChildren(make("div", "hint", "探しています…"));
  try {
    const r = await api("GET", `/api/availability?${params}`);
    box.replaceChildren(make("div", "hint", `${r.members}人の予定から探しました`));
    if (!r.windows.length) { box.append(make("div", "empty", "条件に合う空き時間はありませんでした")); return; }
    let lastDay = "";
    for (const w of r.windows) {
      const s = new Date(w.start_at), en = new Date(w.end_at);
      if (keyDate(s) !== lastDay) { lastDay = keyDate(s); box.append(make("div", "avail-day", fmt(s))); }
      const row = make("div", "avail-slot");
      row.append(make("span", "", `${hhmm(s)} – ${hhmm(en)}`));
      const btn = make("button", "", "ここで予定を作る");
      btn.type = "button";
      btn.onclick = () => {
        const groupId = $("availGroup").value;
        $("availModal").classList.remove("open");
        openForm(null, s, s.getHours());
        $("start").value = hhmm(s);
        const end = new Date(Math.min(s.getTime() + Number(r.duration_minutes) * 60000, en.getTime()));
        $("end").value = keyDate(end) === keyDate(s) ? hhmm(end) : "23:59";
        if (groupId) { $("visibility").value = "group"; $("groupSelect").value = groupId; toggleShare(); }
      };
      row.append(btn);
      box.append(row);
    }
  } catch (err) { if (err.status !== 401) box.replaceChildren(make("div", "empty", `探せませんでした（${err.message}）`)); }
}

// ---------- Google Calendar ----------
async function loadGoogleStatus() {
  const box = $("googleStatus");
  try {
    const s = await api("GET", "/api/google");
    $("googleConnect").hidden = s.connected || !s.configured;
    $("googleSync").hidden = $("googleDisconnect").hidden = !s.connected;
    if (!s.configured) box.textContent = "サーバー側の設定（GOOGLE_TOKEN_KEY）がまだのため利用できません。";
    else if (!s.connected) box.textContent = "未連携です。";
    else box.textContent = `連携中：${s.google_email ?? "Googleアカウント"}（${s.calendar_id === "primary" ? "メインのカレンダー" : s.calendar_id}）\n最終同期：${s.last_synced_at ? new Date(s.last_synced_at).toLocaleString("ja-JP") : "まだ"}${s.last_error ? `\n⚠ ${s.last_error}` : ""}`;
    box.style.whiteSpace = "pre-wrap";
  } catch { box.textContent = "状態を読み込めませんでした"; }
}
async function syncGoogle() {
  $("googleSync").disabled = true;
  try {
    const r = await api("POST", "/api/google/sync");
    toast(`同期しました（更新 ${r.upserted}件 / 削除 ${r.deleted}件）`);
    loadRange(true);
  } catch (err) { toast(err.data?.message ?? "同期できませんでした"); }
  finally { $("googleSync").disabled = false; loadGoogleStatus(); }
}
async function disconnectGoogle() {
  if (!confirm("Googleカレンダーとの連携を解除しますか？取り込んだ予定はこのカレンダーから消えます（Google側の予定は消えません）。")) return;
  try { const r = await api("DELETE", "/api/google"); toast(`連携を解除しました（${r.removed_events}件の予定を削除）`); loadRange(true); }
  catch { toast("解除できませんでした"); }
  loadGoogleStatus();
}

// ---------- API keys ----------
async function loadTokens() {
  const list = $("tokenList");
  try {
    const { tokens } = await api("GET", "/api/tokens");
    list.replaceChildren();
    if (!tokens.length) { list.textContent = "まだありません"; return; }
    for (const t of tokens) {
      const row = make("div", "token-row");
      const info = make("div");
      const used = t.last_used_at ? `最終利用 ${new Date(t.last_used_at).toLocaleString("ja-JP")}` : "未使用";
      info.append(make("b", "", t.name), make("small", "", `${t.scopes.includes("write") ? "読み書き" : "読み取り"} · ${t.revoked_at ? "失効済み" : used}`));
      row.append(info);
      if (!t.revoked_at) {
        const btn = make("button", "", "失効");
        btn.type = "button";
        btn.onclick = async () => {
          if (!confirm(`「${t.name}」を失効させますか？このキーを使っているAIは使えなくなります。`)) return;
          await api("DELETE", `/api/tokens/${t.id}`);
          loadTokens();
        };
        row.append(btn);
      }
      list.append(row);
    }
  } catch { list.textContent = "読み込めませんでした"; }
}
async function createToken() {
  const name = $("tokenName").value.trim();
  if (!name) return toast("キーの名前を入力してください");
  try {
    const t = await api("POST", "/api/tokens", { name, scopes: $("tokenWrite").checked ? ["read", "write"] : ["read"] });
    const box = $("tokenIssued");
    box.hidden = false;
    box.replaceChildren(make("b", "", "このキーは今しか表示されません。コピーして保管してください。"), make("code", "", t.token));
    const copy = make("button", "ghost-btn", "コピー");
    copy.type = "button";
    copy.onclick = async () => { await navigator.clipboard.writeText(t.token); toast("コピーしました"); };
    box.append(copy);
    $("tokenName").value = "";
    loadTokens();
  } catch (err) { if (err.status !== 401) toast(`発行できませんでした（${err.message}）`); }
}

// ---------- shell ----------
let toastTimer;
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
}
function setStatus(text) { $("status").hidden = !text; $("status").textContent = text; }

const LOGIN_ERRORS = { state: "ログインの確認に失敗しました。もう一度お試しください。", google: "Googleとの通信に失敗しました。", not_allowed: "このGoogleアカウントは利用を許可されていません。" };
function showGate() {
  $("app").hidden = true;
  $("gate").hidden = false;
  const error = new URLSearchParams(location.search).get("login_error");
  $("gateError").hidden = !error;
  $("gateError").textContent = LOGIN_ERRORS[error] ?? "";
  $("loginLink").href = `/auth/google/login?return_to=${encodeURIComponent(location.pathname)}`;
}

async function boot() {
  let me;
  try { me = await api("GET", "/api/me"); } catch { return; }
  const googleResult = new URLSearchParams(location.search).get("google");
  if (googleResult) toast({ connected: "Googleカレンダーと連携しました", denied: "連携がキャンセルされました", grant_error: "Googleの許可を取得できませんでした", state_error: "確認に失敗しました。もう一度お試しください" }[googleResult] ?? "");
  if (location.search) history.replaceState(null, "", location.pathname);
  $("gate").hidden = true;
  $("app").hidden = false;
  $("sideFoot").textContent = `${me.name || me.email} でログイン中`;
  const avatar = $("avatar");
  if (me.avatar_url) { const img = make("img"); img.src = me.avatar_url; img.alt = ""; img.referrerPolicy = "no-referrer"; avatar.replaceChildren(img); }
  else avatar.textContent = (me.name || me.email).slice(0, 1);
  refresh();
  loadGroups();
  loadInvitations();
}

$("create").onclick = $("create2").onclick = () => openForm();
$("cancel").onclick = closeForm;
$("allDay").onchange = toggleAllDay;
$("visibility").onchange = toggleShare;
$("form").onsubmit = save;
$("prev").onclick = () => move(-1);
$("next").onclick = () => move(1);
$("today").onclick = () => { state.selected = new Date(today); state.anchor = new Date(today); refresh(); };
document.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => { state.view = b.dataset.view; state.anchor = new Date(state.selected); refresh(); }));
$("search").oninput = render;
$("detailClose").onclick = closeDetail;
$("detail").onclick = (e) => { if (e.target === $("detail")) closeDetail(); };
$("modal").onclick = (e) => { if (e.target === $("modal")) closeForm(); };
$("detailEdit").onclick = () => { const id = state.activeId; closeDetail(); openForm(id); };
$("detailDelete").onclick = removeActive;
$("importButton").onclick = () => $("importFile").click();
$("importFile").onchange = (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) importLegacy(f); };
$("availButton").onclick = async () => { await loadGroups(); openAvailability(); };
$("availSearch").onclick = searchAvailability;
$("availClose").onclick = () => $("availModal").classList.remove("open");
$("googleButton").onclick = () => { $("googleModal").classList.add("open"); loadGoogleStatus(); };
$("googleClose").onclick = () => $("googleModal").classList.remove("open");
$("googleSync").onclick = syncGoogle;
$("googleDisconnect").onclick = disconnectGoogle;
$("groupsButton").onclick = async () => { $("groupsModal").classList.add("open"); await loadGroups(); renderGroupDetails(); };
$("groupsClose").onclick = () => $("groupsModal").classList.remove("open");
$("groupCreate").onclick = createGroup;
$("tokensButton").onclick = () => { $("tokenIssued").hidden = true; $("tokensModal").classList.add("open"); loadTokens(); };
$("tokensClose").onclick = () => $("tokensModal").classList.remove("open");
$("tokenCreate").onclick = createToken;
$("logout").onclick = async () => { await fetch("/auth/logout", { method: "POST" }); location.href = "/"; };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeForm(); closeDetail(); $("tokensModal").classList.remove("open"); $("groupsModal").classList.remove("open"); $("availModal").classList.remove("open"); $("googleModal").classList.remove("open"); } });

boot();
