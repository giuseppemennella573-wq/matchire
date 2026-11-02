import { all } from "./db.ts";

// "Sounds like you": a few of the vendor's own replies, shown to Claude as
// style examples when it drafts. No training: they're picked fresh at draft
// time, only from this vendor, and cleaned first so no old price, date or
// client detail can be copied into a new reply.

export const MAX_EXAMPLES = 5;
const MAX_CHARS = 500;
const MIN_CHARS = 20;

interface Candidate { body: string; purpose: string | null; contact_name: string | null; contact_handle: string | null; contact_email: string | null; phone: number }

/**
 * Up to 5 recent replies the vendor wrote: replies sent from their phone first,
 * then Matchire drafts they edited before sending. Drafts sent unchanged,
 * auto-sends and follow-up templates never count. A mix of situations where
 * possible. Already cleaned.
 */
export function styleExamples(vendorId: number, limit = MAX_EXAMPLES): string[] {
  const rows = all<Candidate>(
    `SELECT m.body, m.purpose, e.contact_name, e.contact_handle, e.contact_email, (m.purpose = 'phone_reply') phone
     FROM messages m JOIN enquiries e ON e.id = m.enquiry_id
     WHERE e.vendor_id = ? AND m.direction = 'out' AND m.template IS NULL
       AND ((m.purpose = 'phone_reply' AND m.status = 'manual') OR (m.edited = 1 AND m.status IN ('sent', 'manual')))
     ORDER BY phone DESC, COALESCE(m.sent_at, m.created_at) DESC LIMIT 60`,
    vendorId,
  );
  const cleaned = rows
    .map((r) => ({ purpose: r.purpose ?? "other", text: cleanExample(r.body, [r.contact_name, r.contact_handle, r.contact_email]) }))
    .filter((r) => r.text.length >= MIN_CHARS);
  // A mix of situations: one per purpose first, then the rest in order.
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const r of cleaned) if (!seen.has(r.purpose) && picked.length < limit) { seen.add(r.purpose); picked.push(r.text); }
  for (const r of cleaned) if (picked.length < limit && !picked.includes(r.text)) picked.push(r.text);
  return [...new Set(picked)].slice(0, limit);
}

/** How many of the vendor's replies Matchire can learn from (for Settings). */
export const styleExampleCount = (vendorId: number) => styleExamples(vendorId).length;

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

/** Removes prices, amounts, dates, times, phone numbers, emails and the client's name. */
export function cleanExample(body: string, contact: (string | null)[] = []): string {
  let t = body;
  for (const c of contact) {
    if (!c) continue;
    for (const part of [c, ...c.split(/\s+/)].filter((p) => p.length >= 3)) {
      t = t.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[name]");
    }
  }
  t = t
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/(?:\+?65[\s-]?)?\b[689]\d{3}[\s-]?\d{4}\b/g, "[phone]")
    .replace(/\+\d[\d\s-]{7,}\d/g, "[phone]")
    // Money: SGD 1,200 · S$450 · $450 · 1.2k · 450 dollars · 450sgd
    .replace(/(?:SGD|S\$|\$|USD)\s?\d[\d,]*(?:\.\d+)?\s?k?\b/gi, "[price]")
    .replace(/\b\d[\d,]*(?:\.\d+)?\s?(?:k\b|sgd\b|dollars?\b|bucks\b)/gi, "[price]")
    .replace(/\b\d{1,3}(?:\.\d+)?\s?%/g, "[percent]")
    // Dates: 15 Nov 2026 · Nov 15 · 15/11/2026 · 2026-11-15
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b(?:,?\\s+\\d{4})?`, "gi"), "[date]")
    .replace(new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`, "gi"), "[date]")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "[date]")
    .replace(/\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/g, "[date]")
    // Times: 7pm · 7:30 pm · 19:00
    .replace(/\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi, "[time]")
    .replace(/\b\d{1,2}:\d{2}\b/g, "[time]")
    // Any number left that could be an amount (guest counts and hours are fine to keep small)
    .replace(/\b\d{3,}(?:,\d{3})*(?:\.\d+)?\b/g, "[number]")
    .replace(/[ \t]+/g, " ")
    .trim();
  return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS).replace(/\s+\S*$/, "")} …` : t;
}

/** Same reply text, ignoring spacing: whether the vendor changed a draft before sending it. */
export const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
