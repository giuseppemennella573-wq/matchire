import type { Item, Quote, Vendor } from "./types.ts";
import { TZ } from "./dates.ts";
import { buildQuote, fmtMoney, type QuoteInput } from "./pricing.ts";

// Small things that make a drafted quote read like the vendor wrote it: the
// deposit in dollars, the hold's actual deadline, a bigger package's full
// price, and a clean line before the total.

/** The deposit percentage: the setting, or the first "30%" in the deposit instructions. */
export function depositPct(v: Pick<Vendor, "deposit_pct" | "deposit_note">): number | null {
  if (v.deposit_pct != null && v.deposit_pct > 0) return v.deposit_pct;
  const m = (v.deposit_note ?? "").match(/(\d{1,3}(?:\.\d+)?)\s?%/);
  const pct = m ? Number(m[1]) : null;
  return pct && pct > 0 && pct <= 100 ? pct : null;
}

/** "A deposit of SGD 300 (30%) secures the date, balance due 7 days before." Whole dollars. */
export function depositLine(v: Pick<Vendor, "deposit_pct" | "deposit_note">, total: number): { amount: number; pct: number; text: string } | null {
  const pct = depositPct(v);
  if (!pct || !(total > 0)) return null;
  const amount = Math.round((total * pct) / 100);
  const bal = (v.deposit_note ?? "").match(/balance[^.]*?(\d+)\s*(days?|weeks?)\s*before/i);
  const balance = bal ? `, balance due ${bal[1]} ${bal[2].toLowerCase()} before` : "";
  return { amount, pct, text: `A deposit of ${fmtMoney(amount)} (${pct}%) secures the date${balance}.` };
}

/** Holds end on the hour, so the planner reads "4pm", not "3:47pm". */
export function holdUntil(fromIso: string, hours: number): string {
  const t = new Date(new Date(fromIso).getTime() + hours * 3600_000);
  if (t.getUTCMinutes() || t.getUTCSeconds() || t.getUTCMilliseconds()) t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
  return t.toISOString();
}

/** "Sun 1 Nov, 4pm" in Singapore time. */
export function formatHoldTime(iso: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-SG", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true })
      .formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const time = `${parts.hour}${parts.minute === "00" ? "" : `:${parts.minute}`}${(parts.dayPeriod ?? "").toLowerCase().replace(/\./g, "")}`;
  return `${parts.weekday} ${parts.day} ${parts.month}, ${time}`;
}

export const holdSentence = (iso: string) => `I'm holding the date for you until ${formatHoldTime(iso)}.`;

/** "Classic Booth 3h" → "classic booth": packages in the same family differ only by hours. */
const family = (name: string) => name.toLowerCase().replace(/\s*[\d.]+\s*(h|hr|hrs|hours?)\b.*$/, "").trim();

/**
 * The next bigger package in the same family ("Classic Booth 4h" after "3h"),
 * priced in full with the add-ons already requested.
 */
export function upsellFor(pkg: Item, items: Item[], addons: Item[], input: Omit<QuoteInput, "pkg" | "addons" | "hours">): { name: string; total: number; text: string } | null {
  if (pkg.pricing !== "flat" || !pkg.included_hours) return null;
  const bigger = items
    .filter((i) => i.kind === "package" && i.active && !i.manual_quote && i.pricing === "flat" && i.id !== pkg.id && (i.included_hours ?? 0) > pkg.included_hours! && family(i.name) === family(pkg.name))
    .sort((a, b) => a.included_hours! - b.included_hours!)[0];
  if (!bigger) return null;
  const q: Quote = buildQuote({ ...input, pkg: bigger, addons, hours: bigger.included_hours });
  if (q.issues.length) return null;
  const extras = addons.map((a) => a.name.charAt(0).toLowerCase() + a.name.slice(1));
  const with_ = extras.length ? ` with the ${extras.join(" and ")}` : "";
  return { name: bigger.name, total: q.total, text: `Want more time? ${bigger.name}${with_} is ${fmtMoney(q.total)}.` };
}

/** A blank line before "Total:", wherever the draft came from, so it never sticks to the last line ("SGD 150Total: …"). */
export function normalizeReply(text: string): string {
  return text.replace(/[ \t]*\n?[ \t]*(\*{0,2}Total\b\s*:)/g, (m, total: string, offset: number, all: string) => {
    if (offset === 0) return total;
    const before = all.slice(0, offset);
    return before.endsWith("\n\n") ? total : `${before.endsWith("\n") ? "\n" : "\n\n"}${total}`;
  });
}
