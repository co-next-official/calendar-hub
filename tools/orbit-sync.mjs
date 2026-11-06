#!/usr/bin/env node
// Loose coupling between Orbit (project/TODO manager) and Calendar Hub, using only their public APIs.
//
//   node tools/orbit-sync.mjs due [--project <orbit_project_id>] [--dry-run]
//     Mirrors Orbit TODO due dates as all-day "〆" events. Done/cancelled TODOs or removed due dates
//     remove their event. Safe to run repeatedly (client_ref keeps it idempotent).
//
//   node tools/orbit-sync.mjs block <orbit_todo_id> [--minutes 90] [--days 7] [--from YYYY-MM-DD]
//                                  [--day-start 09:00] [--day-end 21:00] [--yes]
//     Proposes a work block for a TODO in your first free slot. Creates it only with --yes.
//
// Env: CALENDAR_HUB_URL, CALENDAR_HUB_KEY (read+write key), ORBIT_API, ORBIT_TOKEN, CALENDAR_TZ (default Asia/Tokyo)

const HUB = (process.env.CALENDAR_HUB_URL || "").replace(/\/$/, "");
const HUB_KEY = process.env.CALENDAR_HUB_KEY || "";
const ORBIT = (process.env.ORBIT_API || "").replace(/\/$/, "");
const ORBIT_TOKEN = process.env.ORBIT_TOKEN || "";
const TZ = process.env.CALENDAR_TZ || "Asia/Tokyo";
const DUE_PREFIX = "orbit-todo:";
const BLOCK_PREFIX = "orbit-block:";

function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) { rest.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { flags, rest };
}

async function call(base, token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data.error ?? text.slice(0, 120)}`);
  return data;
}
const hub = (m, p, b) => call(HUB, HUB_KEY, m, p, b);
const orbit = (m, p, b) => call(ORBIT, ORBIT_TOKEN, m, p, b);

/** YYYY-MM-DD of an instant in TZ. */
function localDate(iso) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function orbitTodos(projectId) {
  const { projects } = await orbit("GET", "/projects");
  const targets = projects.filter((p) => (projectId ? p.id === projectId : !["archived", "completed"].includes(p.status)));
  const out = [];
  for (const p of targets) {
    const { todos } = await orbit("GET", `/${p.id}`);
    for (const t of todos) out.push({ ...t, projectName: p.name });
  }
  return out;
}

async function syncDue(flags) {
  const todos = await orbitTodos(flags.project);
  const desired = new Map();
  for (const t of todos) {
    if (!t.due_at || !["todo", "in_progress"].includes(t.status)) continue;
    desired.set(DUE_PREFIX + t.id, {
      title: `〆 ${t.title}`.slice(0, 120),
      notes: `Orbit「${t.projectName}」のTODOの期限${t.priority && t.priority !== "normal" ? `（優先度: ${t.priority}）` : ""}`,
      start_date: localDate(t.due_at),
    });
  }
  const { events } = await hub("GET", `/api/events/by-ref?prefix=${encodeURIComponent(DUE_PREFIX)}`);
  const existing = new Map(events.map((e) => [e.client_ref, e]));
  const plan = { create: [], update: [], remove: [] };
  for (const [ref, want] of desired) {
    const have = existing.get(ref);
    if (!have) plan.create.push([ref, want]);
    else if (have.title !== want.title || have.start_date !== want.start_date || have.notes !== want.notes) plan.update.push([have, want]);
  }
  for (const [ref, have] of existing) if (!desired.has(ref)) plan.remove.push(have);

  for (const [, w] of plan.create) console.log(`+ ${w.start_date} ${w.title}`);
  for (const [h, w] of plan.update) console.log(`~ ${h.start_date}→${w.start_date} ${w.title}`);
  for (const h of plan.remove) console.log(`- ${h.start_date} ${h.title}`);
  if (flags["dry-run"]) { console.log(`(dry run) create ${plan.create.length}, update ${plan.update.length}, remove ${plan.remove.length}`); return; }

  for (const [ref, w] of plan.create) await hub("POST", "/api/events", { ...w, all_day: true, category: "work", timezone: TZ, client_ref: ref });
  for (const [h, w] of plan.update) await hub("PATCH", `/api/events/${h.id}`, { ...w, end_date: addDays(w.start_date, 1), all_day: true, version: h.version });
  // These events were created by this tool for TODOs that are now done/cancelled/undated.
  for (const h of plan.remove) await hub("DELETE", `/api/events/${h.id}?confirm=true`);
  console.log(`created ${plan.create.length}, updated ${plan.update.length}, removed ${plan.remove.length}`);
}

async function proposeBlock(todoId, flags) {
  if (!todoId) throw new Error("usage: block <orbit_todo_id> [--minutes 90] [--yes]");
  const todo = (await orbitTodos()).find((t) => t.id === todoId);
  if (!todo) throw new Error(`Orbit TODO ${todoId} not found`);
  const minutes = Number(flags.minutes ?? 90), days = Number(flags.days ?? 7);
  const from = flags.from ?? localDate(new Date().toISOString());
  const q = new URLSearchParams({ from, to: addDays(from, days), duration: String(minutes), day_start: flags["day-start"] ?? "09:00", day_end: flags["day-end"] ?? "21:00", timezone: TZ });
  const { windows } = await hub("GET", `/api/availability?${q}`);
  if (!windows.length) { console.log(`${from} から ${days} 日の間に ${minutes} 分の空きがありません`); return; }
  const start = new Date(windows[0].start_at), end = new Date(start.getTime() + minutes * 60000);
  const label = new Intl.DateTimeFormat("ja-JP", { timeZone: TZ, month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
  console.log(`提案: ${label.format(start)} – ${label.format(end).split(" ").pop()}  作業: ${todo.title}（${todo.projectName}）`);
  if (!flags.yes) { console.log("（この枠で作るには --yes を付けて実行）"); return; }
  const e = await hub("POST", "/api/events", {
    title: `作業: ${todo.title}`.slice(0, 120), notes: `Orbit「${todo.projectName}」のTODO`, category: "work", timezone: TZ,
    all_day: false, start_at: start.toISOString(), end_at: end.toISOString(), client_ref: `${BLOCK_PREFIX}${todo.id}:${start.toISOString()}`,
  });
  console.log(`作成しました (${e.id})${e.conflicts?.length ? `  ※重なり: ${e.conflicts.map((c) => c.title).join(", ")}` : ""}`);
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseArgs(argv);
  if (!HUB || !HUB_KEY || !ORBIT || !ORBIT_TOKEN) throw new Error("CALENDAR_HUB_URL / CALENDAR_HUB_KEY / ORBIT_API / ORBIT_TOKEN を設定してください");
  if (cmd === "due") return syncDue(flags);
  if (cmd === "block") return proposeBlock(rest[0], flags);
  console.log("commands: due [--project id] [--dry-run] | block <todo_id> [--minutes 90] [--days 7] [--yes]");
}

main().catch((err) => { console.error(`orbit-sync: ${err.message}`); process.exit(1); });
