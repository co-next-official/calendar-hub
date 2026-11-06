// Guest invitation page. The link token lives in the URL fragment and is only sent to /guest/api.
const token = location.hash.slice(1);
const card = document.getElementById("card");
const KEY = `ch_guest_${token.slice(0, 12)}`;
const RESPONSE = { yes: "参加", maybe: "未定", no: "不参加" };
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

function when(e) {
  const f = (d, o) => new Intl.DateTimeFormat("ja-JP", o).format(d);
  if (e.all_day) {
    const s = new Date(`${e.start_date}T00:00:00`), last = new Date(new Date(`${e.end_date}T00:00:00`).getTime() - 86400000);
    const opt = { year: "numeric", month: "long", day: "numeric", weekday: "short" };
    return e.start_date === last.toISOString().slice(0, 10) ? `${f(s, opt)} 終日` : `${f(s, opt)} 〜 ${f(last, opt)} 終日`;
  }
  const s = new Date(e.start_at), en = new Date(e.end_at);
  return `${f(s, { year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" })} – ${f(en, { hour: "2-digit", minute: "2-digit" })}`;
}

function render(e, chosen) {
  card.replaceChildren(el("div", "eyebrow", `${e.host} さんからのお誘い`), el("h1", "", e.title), el("div", "guest-when", when(e)));
  if (e.notes) card.append(el("div", "guest-notes", e.notes));
  const label = el("label", "", "お名前");
  label.htmlFor = "name";
  const name = el("input");
  name.id = "name";
  name.maxLength = 40;
  name.value = store.get(`${KEY}_name`) ?? "";
  const actions = el("div", "guest-actions");
  for (const r of ["yes", "maybe", "no"]) {
    const b = el("button", chosen === r ? "on" : "", RESPONSE[r]);
    b.onclick = async () => {
      if (!name.value.trim()) { name.focus(); return; }
      const res = await fetch(`/guest/api/invites/${encodeURIComponent(token)}/respond`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.value.trim(), response: r, guest_key: store.get(KEY) ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) { alert("送信できませんでした"); return; }
      store.set(KEY, data.guest_key);
      store.set(`${KEY}_name`, name.value.trim());
      store.set(`${KEY}_response`, r);
      render(data, r);
    };
    actions.append(b);
  }
  card.append(el("hr"), label, name, actions);
  if (e.responses.length) card.append(el("div", "guest-responses", e.responses.map((x) => `${x.name}：${RESPONSE[x.response]}`).join("　")));
  card.append(el("p", "guest-notes", `このリンクは ${new Date(e.expires_at).toLocaleDateString("ja-JP")} まで有効です。`));
}

(async () => {
  if (!token) { card.replaceChildren(el("p", "guest-error", "招待リンクが正しくありません。")); return; }
  const res = await fetch(`/guest/api/invites/${encodeURIComponent(token)}`);
  if (!res.ok) { card.replaceChildren(el("div", "eyebrow", "CALENDAR HUB"), el("p", "guest-error", "このリンクは無効か、期限が切れています。送ってくれた人に確認してください。")); return; }
  render(await res.json(), store.get(`${KEY}_response`));
})();
