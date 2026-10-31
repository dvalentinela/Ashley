import { invalid } from "./errors";

/** Parses "45", "45.5", "45.50", "$1,045.00" into integer cents. */
export function parseMoney(input: unknown, field: string, { allowZero = true } = {}): number {
  const raw = String(input ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(raw)) throw invalid(`${field}: enter an amount like 45 or 45.00`);
  const [whole, frac = ""] = raw.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!allowZero && cents === 0) throw invalid(`${field}: must be more than zero`);
  return cents;
}

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

function zoneParts(utcMs: number, tz: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  return p;
}

function offsetMs(utcMs: number, tz: string): number {
  const p = zoneParts(utcMs, tz);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Converts a `datetime-local` value ("2026-11-03T14:30") in `tz` to UTC ms. */
export function localToUtc(local: unknown, tz: string, field: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local ?? "").trim());
  if (!m) throw invalid(`${field}: choose a date and time`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let utc = guess - offsetMs(guess, tz);
  const second = offsetMs(utc, tz);
  if (guess - second !== utc) utc = guess - second;
  return utc;
}

/** UTC ms to a `datetime-local` value in `tz`. */
export function utcToLocalInput(utcMs: number, tz: string): string {
  const p = zoneParts(utcMs, tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function formatTime(utcMs: number | null | undefined, tz: string): string {
  if (utcMs === null || utcMs === undefined) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(utcMs));
}

export function formatWindow(start: number, end: number, tz: string): string {
  return `${formatTime(start, tz)} → ${formatTime(end, tz)}`;
}

export function text(input: unknown, field: string, { max = 4000, required = false } = {}): string {
  const value = String(input ?? "").replace(/\r\n/g, "\n").trim();
  if (required && !value) throw invalid(`${field} is required`);
  if (value.length > max) throw invalid(`${field} is too long (maximum ${max} characters)`);
  return value;
}

export const STATUS_LABELS: Record<string, string> = {
  requested: "Requested — needs review",
  needs_info: "Waiting for customer information",
  quoted: "Quote sent — awaiting approval",
  approved: "Quote approved — awaiting operator acceptance",
  dispatched: "Dispatched",
  in_progress: "In progress",
  blocked: "Blocked",
  completed: "Completed — invoice pending",
  invoiced: "Invoiced",
  paid: "Paid",
  cancelled: "Cancelled",
  declined: "Declined",
};
