// Date helpers pinned to Singapore time, where every vendor operates.

export const TZ = "Asia/Singapore";

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Today's date in Singapore as YYYY-MM-DD. */
export function sgToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dayOfWeek(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCDay();
}

export function isValidIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** "Sat 15 Nov" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-SG", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export function formatDateTime(ts: string | null | undefined): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-SG", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Weekday (Mon–Thu) daytime slots qualify for off-peak pricing. */
export function isOffPeak(date: string | null, slot: string | null): boolean {
  if (!date || !slot) return false;
  const dow = dayOfWeek(date);
  return dow >= 1 && dow <= 4 && (slot === "morning" || slot === "afternoon");
}

/**
 * Resolve the date phrases planners actually write ("next tuesday", "15 Nov",
 * "Sat 13 Dec", "tomorrow") against today's date. Vague phrases ("early Dec",
 * "next month") return an approximate first day so the calendar can still be checked.
 */
export function resolveDate(text: string, today: string = sgToday()): { date: string | null; text: string | null; approximate: boolean } {
  const low = text.toLowerCase();
  const year = Number(today.slice(0, 4));

  if (/\btoday\b|\btonight\b/.test(low)) return { date: today, text: "today", approximate: false };
  if (/\btomorrow\b|\btmr\b|\btmrw\b/.test(low)) return { date: addDays(today, 1), text: "tomorrow", approximate: false };

  // Explicit day + month: "15 Nov", "15th November", "Nov 15"
  const m1 = low.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join("|")})[a-z]*\\b(?:\\s+(\\d{4}))?`));
  const m2 = low.match(new RegExp(`\\b(${MONTHS.join("|")})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`));
  const dm = m1 ? { d: +m1[1], m: MONTHS.indexOf(m1[2]), y: m1[3] ? +m1[3] : null, raw: m1[0] }
    : m2 ? { d: +m2[2], m: MONTHS.indexOf(m2[1]), y: m2[3] ? +m2[3] : null, raw: m2[0] } : null;
  if (dm && dm.d >= 1 && dm.d <= 31) {
    let y = dm.y ?? year;
    let iso = `${y}-${String(dm.m + 1).padStart(2, "0")}-${String(dm.d).padStart(2, "0")}`;
    if (!dm.y && iso < today) {
      y += 1;
      iso = `${y}-${String(dm.m + 1).padStart(2, "0")}-${String(dm.d).padStart(2, "0")}`;
    }
    if (isValidIsoDate(iso)) return { date: iso, text: dm.raw, approximate: false };
  }

  // Numeric: 15/11 or 15/11/2026 (Singapore writes day first)
  const num = low.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (num) {
    let y = num[3] ? (num[3].length === 2 ? 2000 + +num[3] : +num[3]) : year;
    let iso = `${y}-${num[2].padStart(2, "0")}-${num[1].padStart(2, "0")}`;
    if (!num[3] && iso < today) {
      y += 1;
      iso = `${y}-${num[2].padStart(2, "0")}-${num[1].padStart(2, "0")}`;
    }
    if (isValidIsoDate(iso)) return { date: iso, text: num[0], approximate: false };
  }

  // Weekday: "next tuesday", "this sat", "on friday"
  const wd = low.match(/\b(next|this|coming|on)?\s*(monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)\b/);
  if (wd) {
    const target = DOW.indexOf(wd[2].slice(0, 3));
    const cur = dayOfWeek(today);
    let diff = (target - cur + 7) % 7;
    if (diff === 0) diff = 7;
    // "next tuesday" is read as the coming Tuesday, the way planners use it.
    return { date: addDays(today, diff), text: wd[0].trim(), approximate: false };
  }

  // Vague month phrases: "early Dec", "in December", "next month"
  // A bare "may" is usually the verb, so it only counts with a prefix ("in May", "early May").
  const FULL = ["january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december"];
  const vague = low.match(new RegExp(`\\b(early|mid|late|end of|in)\\s+(${MONTHS.join("|")})[a-z]*\\b`))
    || low.match(new RegExp(`\\b()(${FULL.join("|")}|${MONTHS.filter((m) => m !== "may").join("|")})\\b`));
  if (vague) {
    const m = MONTHS.indexOf(vague[2].slice(0, 3));
    const day = vague[1] === "mid" ? 15 : vague[1] === "late" || vague[1] === "end of" ? 25 : 1;
    let y = year;
    let iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (iso < today.slice(0, 8) + "01") {
      y += 1;
      iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return { date: iso, text: vague[0].trim(), approximate: true };
  }
  if (/\bnext month\b/.test(low)) {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + 1, 1);
    return { date: d.toISOString().slice(0, 10), text: "next month", approximate: true };
  }
  return { date: null, text: null, approximate: false };
}

const MONTH_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DAY_RE = "mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";

/**
 * The planner wrote a weekday that doesn't match the date ("Sat 15 Nov" when the
 * 15th is a Sunday). Returns both readings, earlier first, as YYYY-MM-DD: the
 * nearest date with the weekday they wrote, and the date they wrote. `iso` is
 * the date that was read from the message; null if the text doesn't name a
 * date near it with a weekday, or the weekday is right.
 */
export function weekdayMismatch(text: string, iso: string): { options: [string, string] } | null {
  const low = text.toLowerCase();
  const patterns = [
    // "Sat 15 Nov", "Saturday, 15th of November"
    new RegExp(`\\b(${DAY_RE})\\.?,?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_RE})\\b`, "g"),
    // "15 Nov (Sat)", "15th November, Saturday"
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_RE})\\b,?\\s*\\(?(${DAY_RE})\\b`, "g"),
    // "Saturday, November 15"
    new RegExp(`\\b(${DAY_RE})\\.?,?\\s+(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "g"),
  ];
  for (const [n, re] of patterns.entries()) {
    for (const m of low.matchAll(re)) {
      const [wd, d, mo] = n === 0 ? [m[1], m[2], m[3]] : n === 1 ? [m[3], m[1], m[2]] : [m[1], m[3], m[2]];
      // The date as written, in the event's year. It must be near the date that was read: the reader may already
      // have "corrected" it to the weekday (read Sat 14 for "Sat 15 Nov"), which still needs the planner to confirm.
      const mi = MONTHS.indexOf(mo.slice(0, 3));
      const written = `${iso.slice(0, 4)}-${String(mi + 1).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`;
      if (mi < 0 || !isValidIsoDate(written) || Math.abs(Date.parse(written) - Date.parse(iso)) > 3 * 86400_000) continue;
      const stated = DOW.indexOf(wd.slice(0, 3));
      if (stated < 0 || stated === dayOfWeek(written)) continue;
      // The nearest date with the weekday they wrote (within 3 days either side).
      const shift = [1, -1, 2, -2, 3, -3].find((k) => dayOfWeek(addDays(written, k)) === stated)!;
      const other = addDays(written, shift);
      return { options: other < written ? [other, written] : [written, other] };
    }
  }
  return null;
}
