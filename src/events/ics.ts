// RFC 5545 export: a single event (download) or a whole calendar (subscription feed).
type IcsEvent = {
  id: string; title: string; notes: string; all_day: boolean;
  start_date: string | null; end_date: string | null; start_at: string | null; end_at: string | null; updated_at: string;
};

function escapeText(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds lines longer than 75 octets as the spec requires. */
function fold(line: string) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  for (const ch of line) {
    if (enc.encode(current + ch).length > (out.length ? 74 : 75)) { out.push(current); current = ""; }
    current += ch;
  }
  out.push(current);
  return out.join("\r\n ");
}

const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (d: string) => d.replace(/-/g, "");

function vevent(e: IcsEvent, host: string): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${e.id}@${host}`, `DTSTAMP:${stamp(e.updated_at)}`,
    ...(e.all_day ? [`DTSTART;VALUE=DATE:${day(e.start_date!)}`, `DTEND;VALUE=DATE:${day(e.end_date!)}`] : [`DTSTART:${stamp(e.start_at!)}`, `DTEND:${stamp(e.end_at!)}`]),
    `SUMMARY:${escapeText(e.title)}`,
    ...(e.notes ? [`DESCRIPTION:${escapeText(e.notes)}`] : []),
    "END:VEVENT",
  ];
}

export function toIcsCalendar(list: IcsEvent[], host: string, name?: string): string {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Calendar Hub//JA", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    ...(name ? [`X-WR-CALNAME:${escapeText(name)}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"] : []),
    ...list.flatMap((e) => vevent(e, host)),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function toIcs(e: IcsEvent, host: string): string {
  return toIcsCalendar([e], host);
}
