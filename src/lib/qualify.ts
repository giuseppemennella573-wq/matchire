import type { Details } from "./types.ts";
import { formatDate } from "./dates.ts";

// Qualify before quoting. No price (not a total, a range or a "from" price)
// goes to a planner until Matchire knows the event date plus at least one more
// detail. Vendors can ask for more in Settings → AI & sending → "Before quoting,
// ask for". The vendor can always override per enquiry ("Send price anyway").

export const QUALIFY_FIELDS = [
  { id: "pax", label: "Guest count", ask: "roughly how many guests" },
  { id: "venue", label: "Venue or location", ask: "where it'll be" },
  { id: "hours", label: "Duration (hours)", ask: "how many hours you need" },
  { id: "event_type", label: "Event type", ask: "what the occasion is" },
  { id: "budget", label: "Budget", ask: "your rough budget" },
] as const;
export type QualifyField = "date" | (typeof QUALIFY_FIELDS)[number]["id"];

/** With nothing ticked, any one of these (plus the date) is enough. */
const ANY_ONE: QualifyField[] = ["pax", "venue", "hours", "event_type"];
const ASK: Record<QualifyField, string> = { date: "the date", ...Object.fromEntries(QUALIFY_FIELDS.map((f) => [f.id, f.ask])) } as Record<QualifyField, string>;

/** The vendor's "Before quoting, ask for" setting ("pax,venue"), as field ids. Empty means the default. */
export function requiredFields(setting: string | null | undefined): QualifyField[] {
  const ids = new Set(QUALIFY_FIELDS.map((f) => f.id as string));
  return (setting ?? "").split(",").map((s) => s.trim()).filter((s) => ids.has(s)) as QualifyField[];
}

export function hasField(d: Details, f: QualifyField): boolean {
  switch (f) {
    case "date": return !!d.event_date && !d.date_is_approximate;
    case "pax": return d.pax != null && d.pax > 0;
    case "venue": return !!d.location?.trim();
    case "hours": return d.hours != null && d.hours > 0;
    case "event_type": return !!d.event_type;
    case "budget": return d.budget != null && d.budget > 0;
  }
}

/**
 * Whether an enquiry may be quoted, and what to ask for if not (at most two
 * questions, the date first).
 */
export function qualification(d: Details, required: QualifyField[] = []): { qualified: boolean; missing: QualifyField[] } {
  const missing: QualifyField[] = [];
  if (!hasField(d, "date")) missing.push("date");
  if (required.length) missing.push(...required.filter((f) => !hasField(d, f)));
  else if (!ANY_ONE.some((f) => hasField(d, f))) missing.push("pax");
  return { qualified: missing.length === 0, missing: missing.slice(0, 2) };
}

/** "What's the date and roughly how many guests?" */
export function qualifyQuestion(missing: QualifyField[]): string {
  const asks = missing.slice(0, 2).map((f) => ASK[f]);
  if (missing[0] === "date") return `What's the date${asks[1] ? ` and ${asks[1]}` : ""}?`;
  return `Could you share ${asks.join(" and ")}?`;
}

/** The planner is asking what it costs. */
export function asksPrice(text: string): boolean {
  return /\b(how much|price|pricing|prices|rate|rates|cost|costs|quote|quotation|package list|rate card|charges?)\b/i.test(text);
}

/** What's known, for the inbox: "Sat 12 Dec · 120 pax · Marina Bay". */
export function qualifySummary(d: Details): string {
  return [d.event_date && formatDate(d.event_date), d.pax && `${d.pax} pax`, d.hours && `${d.hours}h`, d.location].filter(Boolean).join(" · ");
}
