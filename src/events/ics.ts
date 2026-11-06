// Minimal RFC 5545 export of a single event.
type IcsEvent = {
  id: string; title: string; notes: string; all_day: boolean;
  start_date: string | null; end_date: string | null; start_at: string | null; end_at: string | null; updated_at: string;
};

function escapeText(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds lines longer than 75 octets as the spec requires. */
function fold(line: string) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = "";
  for (const ch of line) {
    if (new TextEncoder().encode(current + ch).length > (out.length ? 74 : 75)) { out.push(current); current = ""; }
    current += ch;
  }
  out.push(current);
  return out.join("\r\n ");
}

const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (d: string) => d.replace(/-/g, "");

export function toIcs(e: IcsEvent, host: string): string {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Calendar Hub//JA", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${e.id}@${host}`, `DTSTAMP:${stamp(e.updated_at)}`,
    ...(e.all_day ? [`DTSTART;VALUE=DATE:${day(e.start_date!)}`, `DTEND;VALUE=DATE:${day(e.end_date!)}`] : [`DTSTART:${stamp(e.start_at!)}`, `DTEND:${stamp(e.end_at!)}`]),
    `SUMMARY:${escapeText(e.title)}`,
    ...(e.notes ? [`DESCRIPTION:${escapeText(e.notes)}`] : []),
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
