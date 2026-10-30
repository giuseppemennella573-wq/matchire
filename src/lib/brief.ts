import type { Details, Enquiry, Hold, Message, Vendor } from "./types.ts";
import { formatDate, formatDateTime } from "./dates.ts";
import { fmtMoney } from "./pricing.ts";
import { hasField } from "./qualify.ts";

// Brief mode, for custom services: Matchire qualifies the planner, holds the
// date and hands the vendor a brief, but never quotes. The vendor writes the
// quote; once it's sent, the normal follow-ups start.

export interface Brief {
  client: string;
  contact: string | null;
  date: string | null;
  hold: { status: "held" | "not held"; until: string | null };
  pax: number | null;
  venue: string | null;
  budget: number | null;
  style: string | null;
  /** The planner's own words, a few key messages. */
  quotes: string[];
  missing: string[];
  /** The vendor's own questions, to check against the planner's words. */
  questions: string[];
  dueAt: string | null;
}

const BRIEF_ASKS: { has: (d: Details) => boolean; label: string; ask: string }[] = [
  { has: (d) => hasField(d, "date"), label: "date", ask: "the date" },
  { has: (d) => hasField(d, "pax"), label: "guest count", ask: "roughly how many guests" },
  { has: (d) => hasField(d, "venue"), label: "venue", ask: "where it'll be" },
  { has: (d) => hasField(d, "budget"), label: "budget", ask: "your rough budget" },
  { has: (d) => !!d.style?.trim(), label: "style or theme", ask: "the style or theme you have in mind" },
];

export const vendorQuestions = (v: Pick<Vendor, "brief_questions">) =>
  (v.brief_questions ?? "").split("\n").map((q) => q.trim()).filter(Boolean);

/** What the brief still lacks, by label. */
export function briefMissing(d: Details): string[] {
  return BRIEF_ASKS.filter((a) => !a.has(d)).map((a) => a.label);
}

/**
 * Up to two more questions to tailor the quote, asked alongside "we'll send a
 * tailored quote": the brief's missing details first, then the vendor's own
 * questions. Questions already asked in this conversation aren't asked again.
 */
export function briefAsks(d: Details, v: Pick<Vendor, "brief_questions">, alreadySent: string[]): string[] {
  const sent = alreadySent.join("\n").toLowerCase();
  const asks = [
    ...BRIEF_ASKS.filter((a) => !a.has(d)).map((a) => a.ask),
    ...vendorQuestions(v).map((q) => (q.endsWith("?") ? q : `${q}?`)),
  ].filter((q) => !sent.includes(q.toLowerCase().replace(/\?$/, "")));
  return asks.slice(0, 2);
}

export function buildBrief(e: Enquiry, d: Details, msgs: Message[], v: Pick<Vendor, "brief_questions">, hold: Hold | null, dueAt: string | null): Brief {
  return {
    client: e.contact_name || d.contact_name || e.contact_handle || `Enquiry #${e.id}`,
    contact: [e.contact_handle, e.contact_email].filter((x, i, a) => x && a.indexOf(x) === i).join(" · ") || null,
    date: hasField(d, "date") ? d.event_date : null,
    hold: hold ? { status: "held", until: hold.expires_at } : { status: "not held", until: null },
    pax: d.pax,
    venue: d.location,
    budget: d.budget,
    style: d.style ?? null,
    quotes: msgs.filter((m) => m.direction === "in").slice(0, 3).map((m) => (m.body.length > 280 ? m.body.slice(0, 277) + "…" : m.body)),
    missing: briefMissing(d),
    questions: vendorQuestions(v),
    dueAt,
  };
}

/** The brief as plain text, for the email and the note in the thread. */
export function briefText(b: Brief): string {
  const row = (k: string, val: string | null | undefined) => `${k.padEnd(10)} ${val || "–"}`;
  return [
    row("Client:", b.client),
    row("Contact:", b.contact),
    row("Date:", b.date ? formatDate(b.date) : null),
    row("Hold:", b.hold.status === "held" ? `held until ${formatDateTime(b.hold.until)}` : "not held"),
    row("Guests:", b.pax ? String(b.pax) : null),
    row("Venue:", b.venue),
    row("Budget:", b.budget ? fmtMoney(b.budget) : null),
    row("Style:", b.style),
    b.dueAt ? row("Quote by:", formatDateTime(b.dueAt)) : null,
    "",
    "In their words:",
    ...b.quotes.map((q) => `  “${q.replace(/\s*\n\s*/g, " ")}”`),
    b.missing.length ? `\nStill missing: ${b.missing.join(", ")}` : null,
    b.questions.length ? `\nYour questions (check their words above):\n${b.questions.map((q) => `  - ${q}`).join("\n")}` : null,
  ].filter((l) => l !== null).join("\n");
}
