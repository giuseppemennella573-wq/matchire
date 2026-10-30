import { all, get, run, tx, nowIso } from "./db.ts";
import type { Channel, Details, Enquiry, Hold, Item, Message, PartnerView, Quote, Vendor } from "./types.ts";
import { EMPTY_DETAILS, OPEN_STATUSES, VENDOR_KINDS } from "./types.ts";
import { buildQuote, allowedAmounts, unknownAmounts, fmtMoney } from "./pricing.ts";
import { parseEnquiry } from "./heuristics.ts";
import { aiEnabled, aiExtract, aiDraft, type DraftFacts } from "./ai.ts";
import { addDays, dayOfWeek, formatDate, formatDateTime, sgToday } from "./dates.ts";
import { deliver, deliverTemplate, sendRawEmail, viaWhatsAppApi, type SendResult, type WaTemplate } from "./channels.ts";
import { maybeDailyBackup } from "./backup.ts";
import { asksPrice, qualification, qualifyQuestion, requiredFields } from "./qualify.ts";
import { fishingSignal } from "./fishing.ts";
import { briefAsks, briefText, buildBrief, type Brief } from "./brief.ts";
import { depositLine, holdSentence, holdUntil, normalizeReply, upsellFor } from "./polish.ts";

// The booking desk. An enquiry flows: ingest → understand → quote → draft →
// (approve) → send → hold the date → follow up → booked / lost / expired.

// ---------- Reads ----------

export const getVendor = (id: number) => get<Vendor>("SELECT * FROM vendors WHERE id = ?", id);
export const getItems = (vendorId: number) => all<Item>("SELECT * FROM items WHERE vendor_id = ? ORDER BY kind DESC, sort, id", vendorId);
export const getEnquiry = (vendorId: number, id: number) => get<Enquiry>("SELECT * FROM enquiries WHERE id = ? AND vendor_id = ?", id, vendorId);
export const getMessages = (enquiryId: number) => all<Message>("SELECT * FROM messages WHERE enquiry_id = ? ORDER BY id", enquiryId);
export const pendingDraft = (enquiryId: number) =>
  get<Message>("SELECT * FROM messages WHERE enquiry_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1", enquiryId);

export function parseDetails(e: Pick<Enquiry, "details">): Details {
  try { return { ...EMPTY_DETAILS, ...JSON.parse(e.details) }; } catch { return { ...EMPTY_DETAILS }; }
}
export function parseQuote(e: Pick<Enquiry, "quote">): Quote | null {
  try { return e.quote ? JSON.parse(e.quote) : null; } catch { return null; }
}

export function kindLabel(kind: string): string {
  return VENDOR_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

/** Jobs already committed on a date: active holds, bookings and blocks. */
export function availability(vendor: Vendor, date: string, excludeEnquiry?: number) {
  const rows = all<Hold>("SELECT * FROM holds WHERE vendor_id = ? AND date = ? AND status = 'active'", vendor.id, date);
  if (rows.some((h) => h.kind === "block")) return { available: false, used: rows.length, capacity: vendor.jobs_per_day, blocked: true };
  const used = rows.filter((h) => h.enquiry_id == null || h.enquiry_id !== excludeEnquiry).length;
  return { available: used < vendor.jobs_per_day, used, capacity: vendor.jobs_per_day, blocked: false };
}

/** Fri–Sun count as weekend dates, Mon–Thu as weekdays. */
const weekendish = (iso: string) => [0, 5, 6].includes(dayOfWeek(iso));

/**
 * Up to `n` free dates within a week of a booked one, nearest first, preferring
 * the same kind of day (weekend for a weekend). Never today or earlier.
 */
export function alternativeDates(vendor: Vendor, date: string, excludeEnquiry?: number, n = 2, today = sgToday()): string[] {
  const out: { d: string; score: number }[] = [];
  for (let k = 1; k <= 7; k++) {
    for (const d of [addDays(date, -k), addDays(date, k)]) {
      if (d <= today || !availability(vendor, d, excludeEnquiry).available) continue;
      out.push({ d, score: k + (weekendish(d) === weekendish(date) ? 0 : 10) + (d < date ? 0 : 0.5) });
    }
  }
  return out.sort((a, b) => a.score - b.score).slice(0, n).map((x) => x.d).sort();
}

/** "Fri 20 or Sun 22 Nov", or "Sat 31 Oct or Sun 1 Nov". */
export function formatDateChoice(dates: string[]): string {
  const parts = dates.map((d) => formatDate(d).replace(",", ""));
  if (parts.length === 2 && dates[0].slice(0, 7) === dates[1].slice(0, 7)) return `${parts[0].replace(/\s+\S+$/, "")} or ${parts[1]}`;
  return parts.join(" or ");
}

/** The planner picked one of the dates we offered ("Sunday works", "the 22nd please"). */
export function pickAlternative(text: string, alternatives: string[]): string | null {
  const low = text.toLowerCase();
  const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const hits = alternatives.filter((d) => {
    const dow = DAYS[dayOfWeek(d)];
    const dom = String(Number(d.slice(8)));
    return new RegExp(`\\b${dow}`).test(low) || new RegExp(`\\b${dom}(st|nd|rd|th)?\\b`).test(low);
  });
  return hits.length === 1 ? hits[0] : null;
}

/** Partners in the vendor's own category first (they can cover a date the vendor can't), then the rest. */
export function partnersForReferral(vendor: Vendor): Vendor[] {
  const all = acceptedPartners(vendor.id);
  return [...all.filter((p) => p.kind === vendor.kind), ...all.filter((p) => p.kind !== vendor.kind)];
}

/** Demo accounts only ever partner with other demo accounts, so a real planner can't end up in a demo. */
export const canPartner = (a: Pick<Vendor, "is_demo">, b: Pick<Vendor, "is_demo">) => !!a.is_demo === !!b.is_demo;

export function acceptedPartners(vendorId: number): Vendor[] {
  return all<Vendor>(
    `SELECT v.* FROM partnerships p JOIN vendors v ON v.id = CASE WHEN p.requester_id = ? THEN p.partner_id ELSE p.requester_id END
     WHERE (p.requester_id = ? OR p.partner_id = ?) AND p.status = 'accepted' ORDER BY v.name`,
    vendorId, vendorId, vendorId,
  );
}

// ---------- Rate privacy ----------
// A vendor's price list is private to their account. The only price another
// business can ever see is a partner's lowest live package, and only when that
// partner has turned on "Share my starting price with partners". Everything
// that shows partners to another vendor or their clients goes through here.

/** A partner's cheapest live package with its unit ("/pax", "/hour"), or null unless they share it. */
export function sharedFromPrice(partner: Pick<Vendor, "id" | "share_from_price">): { price: number; unit: string } | null {
  if (!partner.share_from_price) return null;
  const r = get<{ price: number; pricing: string }>("SELECT price, pricing FROM items WHERE vendor_id = ? AND kind = 'package' AND active = 1 ORDER BY price LIMIT 1", partner.id);
  return r ? { price: r.price, unit: r.pricing === "per_pax" ? "/pax" : r.pricing === "per_hour" ? "/hour" : "" } : null;
}

/** "Catering" → "catering", but "AV & sound" stays as it is. */
const categoryOf = (kind: string) => {
  const label = kindLabel(kind);
  return /^.[a-z]/.test(label) ? label.toLowerCase() : label;
};

export function partnerView(partner: Vendor): { view: PartnerView; price: number | null } {
  const fp = sharedFromPrice(partner);
  return { view: { name: partner.name, category: categoryOf(partner.kind), from_price: fp ? `${fmtMoney(fp.price)}${fp.unit}` : null }, price: fp?.price ?? null };
}

// ---------- Intake ----------

export interface IngestInput {
  vendorId: number;
  channel: Channel;
  text: string;
  name?: string | null;
  handle?: string | null; // phone number, IG handle or email
  email?: string | null;
  referredFrom?: number | null;
}

/** Record an inbound message. Replies on an open conversation join it; anything else starts a new enquiry. */
export function ingest(input: IngestInput): { enquiryId: number; isNew: boolean } {
  const text = input.text.trim();
  if (!text) throw new Error("Empty message");
  const handle = input.handle?.trim() || input.email?.trim() || null;
  return tx(() => {
    // Expired quotes count as open: a planner replying after the hold lapsed is the same conversation.
    const joinable = [...OPEN_STATUSES, "expired"];
    const open = handle && !input.referredFrom
      ? get<Enquiry>(
          `SELECT * FROM enquiries WHERE vendor_id = ? AND (contact_handle = ? OR contact_email = ?) AND status IN (${joinable.map(() => "?").join(",")})
           AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 days') ORDER BY id DESC LIMIT 1`,
          input.vendorId, handle, handle, ...joinable,
        )
      : undefined;
    const now = nowIso();
    if (open) {
      run("INSERT INTO messages (enquiry_id, direction, body, status, created_at) VALUES (?, 'in', ?, 'sent', ?)", open.id, text, now);
      // The planner replied, so pending nudges are no longer needed.
      run(
        "UPDATE enquiries SET last_inbound_at = ?, next_followup_at = NULL, status = CASE WHEN status = 'expired' THEN 'quoted' ELSE status END, updated_at = ? WHERE id = ?",
        now, now, open.id,
      );
      return { enquiryId: open.id, isNew: false };
    }
    const id = run(
      `INSERT INTO enquiries (vendor_id, channel, contact_name, contact_handle, contact_email, status, last_inbound_at, referred_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)`,
      input.vendorId, input.channel, input.name?.trim() || null, handle, input.email?.trim() || null, now, input.referredFrom ?? null, now, now,
    );
    run("INSERT INTO messages (enquiry_id, direction, body, status, created_at) VALUES (?, 'in', ?, 'sent', ?)", id, text, now);
    return { enquiryId: id, isNew: true };
  });
}

/**
 * The vendor replied to a planner from the WhatsApp Business app on their phone
 * (a coexistence number: Meta sends a copy as an smb_message_echoes webhook).
 * Their reply stands: it joins the conversation, any pending draft is dropped
 * and follow-ups stop, so the planner never gets a second answer from Matchire.
 * Chats that aren't an enquiry in Matchire are left alone.
 */
export function recordPhoneReply(vendorId: number, planner: string, text: string): { enquiryId: number } | null {
  const body = text.trim();
  const digits = planner.replace(/\D/g, "");
  if (!body || !digits) return null;
  return tx(() => {
    const e = get<Enquiry>(
      `SELECT * FROM enquiries WHERE vendor_id = ? AND channel = 'whatsapp' AND REPLACE(REPLACE(REPLACE(contact_handle, '+', ''), ' ', ''), '-', '') = ?
       AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 days') ORDER BY id DESC LIMIT 1`,
      vendorId, digits,
    );
    if (!e) return null;
    const now = nowIso();
    // Meta may also echo a message Matchire itself just sent; don't record it twice.
    const dup = get("SELECT 1 FROM messages WHERE enquiry_id = ? AND direction = 'out' AND status IN ('sent','manual') AND body = ? AND COALESCE(sent_at, created_at) > strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')", e.id, body);
    if (dup) return { enquiryId: e.id };
    run("INSERT INTO messages (enquiry_id, direction, body, status, purpose, created_at, sent_at) VALUES (?, 'out', ?, 'manual', 'phone_reply', ?, ?)", e.id, body, now, now);
    run("UPDATE messages SET status = 'discarded' WHERE enquiry_id = ? AND status = 'draft'", e.id);
    run(
      `UPDATE enquiries SET first_response_at = COALESCE(first_response_at, ?), last_outbound_at = ?, next_followup_at = NULL, owner_reason = NULL,
       status = CASE WHEN status = 'new' THEN 'awaiting_info' ELSE status END, updated_at = ? WHERE id = ?`,
      now, now, now, e.id,
    );
    // Brief mode: a priced reply from the vendor's phone is their quote.
    if (e.brief_status === "waiting" && looksLikeQuote(body)) markBriefQuoted(vendorId, e.id, now);
    return { enquiryId: e.id };
  });
}

// ---------- Understanding + drafting ----------

function mergeDetails(prev: Details | null, next: Details): Details {
  if (!prev) return next;
  const out: Details = { ...prev };
  for (const [k, v] of Object.entries(next) as [keyof Details, unknown][]) {
    if (v === null || v === undefined || (Array.isArray(v) && !v.length && k !== "questions")) continue;
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  out.questions = next.questions;
  out.intent = next.intent;
  out.needs_owner = next.needs_owner;
  out.owner_reason = next.owner_reason;
  out.needs = [...new Set([...prev.needs, ...next.needs])];
  return out;
}

function missingFields(vendor: Vendor, d: Details, pkg: Item | null): string[] {
  const m: string[] = [];
  if (!d.event_date) m.push("your event date");
  else if (d.date_is_approximate) m.push("the exact date");
  const paxMatters = pkg?.pricing === "per_pax" || vendor.capacity != null || vendor.kind === "venue" || vendor.kind === "caterer";
  if (!d.pax && paxMatters) m.push("the number of guests");
  if (!d.slot && !d.start_time && vendor.kind !== "caterer") m.push("the start time");
  return m;
}

function quoteText(q: Quote): string {
  const lines = q.lines.map((l) => `• ${l.label}: ${fmtMoney(l.amount)}${l.full != null ? ` (usually ${fmtMoney(l.full)})` : ""}`);
  return `${lines.join("\n")}\n\nTotal: ${fmtMoney(q.total)}`;
}

/** Deterministic reply used without an API key, and whenever a model draft fails a check. */
const partnerLine = (p: PartnerView) =>
  `Our partner ${p.name} (${p.category}) ${p.from_price ? `starts from ${p.from_price} and ` : ""}can quote you directly.`;

export function templateDraft(vendor: Vendor, f: DraftFacts): string {
  const d = f.details;
  const hi = `Hi${d.contact_name ? ` ${d.contact_name}` : ""}! `;
  const sign = `\n\nThanks,\n${vendor.signoff || vendor.name}`;
  const when = d.event_date ? `${formatDate(d.event_date)}${d.slot && d.slot !== "full_day" ? ` ${d.slot}` : ""}` : "";
  const ask = f.missing.length ? `\n\nCould you share ${f.missing.join(" and ")}? Then I'll confirm availability.` : "";
  switch (f.purpose) {
    case "over_capacity":
      return `${hi}Thanks for reaching out to ${vendor.name} 😊\n\nOur space fits up to ${vendor.capacity} guests, so ${d.pax} would be too many for us. I'd be happy to introduce a partner venue that fits your group.${sign}`;
    case "unavailable": {
      // Never a price for a date we can't do. Offer nearby free dates, and a partner who may be free.
      let r = `${hi}Thanks for reaching out to ${vendor.name} 😊\n\nUnfortunately we're fully booked on ${when || "that date"}.`;
      const alts = f.alternatives?.join(" or ") ?? "";
      r += alts ? ` I'm free on ${alts}, would ${alts.includes(" or ") ? "either" : "that"} work?` : " Would another date work for you?";
      if (f.fixedDatePartner) {
        const nth = d.event_date ? `the ${ordinal(Number(d.event_date.slice(8)))}` : "your date";
        const part = d.slot === "morning" ? "that morning" : d.slot === "afternoon" ? "that afternoon" : d.slot === "evening" ? "that evening" : "that day";
        const p = f.fixedDatePartner;
        r += p === "unnamed"
          ? `\n\nIf ${nth} is fixed, I can connect you with a trusted partner who may be free ${part}.`
          : `\n\nIf ${nth} is fixed, our trusted partner ${p.name} (${p.category}${p.from_price ? `, from ${p.from_price}` : ""}) may be free ${part}. Happy to connect you.`;
      }
      return r + sign;
    }
    case "referred":
      return `${hi}Thanks for thinking of ${vendor.name}! We're not able to take ${when || "this booking"}, so I've passed your details to our trusted partner ${f.referredTo}, who'll be in touch with you shortly.${sign}`;
    case "confirm":
      return `${hi}Wonderful, thank you! 🎉 We'd love to have you on ${when || "your date"}.${f.quote ? `\n\nTotal: ${fmtMoney(f.quote.total)}` : ""}${f.depositText ? `\n\n${f.depositText}` : ""}\n\n${f.depositNote || "I'll send the deposit details shortly to lock in your booking."}${sign}`;
    case "followup":
      if (!f.quote && f.quoteSent) return `${hi}Just checking in on the quote for ${when || "your event"}. Happy to adjust anything, or answer any questions.${sign}`;
      if (!f.quote) return `${hi}Just checking in about ${when || "your event"}. Whenever you're ready, share a few details and I'll send you exact pricing.${sign}`;
      return `${hi}Just checking in on the quote for ${when || "your event"}${f.quote ? ` (${fmtMoney(f.quote.total)})` : ""}. Happy to adjust anything, or answer any questions. Shall I keep the date for you?${sign}`;
    case "last_call":
      return `${hi}A quick heads-up: I'm holding ${when || "your date"} for you until tomorrow, after which it opens up for other enquiries. Just reply "yes" if you'd like to go ahead!${sign}`;
    case "qualify": {
      // No price yet, not even a "from" price: ask for what's needed to quote.
      const priced = f.askedPrice ? "Happy to send exact pricing! " : "I'd love to help. ";
      return `${hi}Thanks for reaching out to ${vendor.name} 😊\n\n${priced}${f.missing[0] ?? "What's the date?"}${sign}`;
    }
    case "brief": {
      // The vendor writes this quote. Never a price here, not even a range.
      let r = `${hi}Thanks for all the details! ${vendor.name} will send you a tailored quote within ${f.briefHours ?? 24} hours.`;
      if (f.holdHours && when) r += ` I've pencilled in ${when} for you in the meantime.`;
      // Missing details read as "could you share X and Y?"; the vendor's own questions are asked as written.
      const share = f.missing.filter((q) => !q.endsWith("?"));
      const own = f.missing.filter((q) => q.endsWith("?"));
      if (share.length) r += `\n\nTo tailor it, could you share ${share.join(" and ")}?`;
      if (own.length) r += `${share.length ? " " : "\n\n"}${own.join(" ")}`;
      return r + sign;
    }
    case "answer":
    case "ask_info":
    case "quote":
    default: {
      let r = `${hi}Thanks for reaching out to ${vendor.name} 😊\n\n`;
      if (f.available && when && !d.date_is_approximate) r += `Good news, we're available ${when}. `;
      if (f.quote && f.quote.lines.length) r += `Here's your quote:\n${quoteText(f.quote)}`;
      if (f.quote?.unpriced_hours) r += `\n\nI'll confirm the price for the extra ${f.quote.unpriced_hours}h shortly.`;
      if (f.upsellText) r += `\n\n${f.upsellText}`;
      if (f.depositText && f.purpose === "quote") r += `\n\n${f.depositText}`;
      if (f.quote?.offpeak) r += `\n(includes our weekday daytime rate)`;
      if (f.partnerSuggestions.length) r += `\n\nPlanning the rest of the event? ${f.partnerSuggestions.map(partnerLine).join(" ")}`;
      r += ask;
      if (!f.missing.length && f.holdHours) r += `\n\n${f.holdText ?? `I've pencilled in the date for you for ${f.holdHours} hours.`} Shall I go ahead and confirm?`;
      if (d.questions.length && f.purpose === "answer") r += `\n\nI'll check on your question and get back to you shortly.`;
      return r + sign;
    }
  }
}

/** Amounts a draft may mention. A qualifying reply may mention none. */
export function draftAllowedAmounts(purpose: DraftFacts["purpose"], quote: Quote | null, items: Item[], extra: number[]): Set<number> {
  return purpose === "qualify" ? new Set() : allowedAmounts(quote, items, extra);
}

/** Raise the price-fishing flag on an enquiry if a signal fits. Returns the reason, or null. */
function checkFishing(e: Enquiry, msgs: Message[], details: Details, items: Item[], today: string): string | null {
  const inbound = msgs.filter((m) => m.direction === "in");
  const firstAsk = msgs.find((m) => m.direction === "out" && (m.status === "sent" || m.status === "manual") && (m.purpose === "qualify" || m.purpose === "ask_info"));
  const handle = e.contact_handle || e.contact_email;
  const recent = handle
    ? all<{ id: number; event_date: string | null }>(
        "SELECT id, event_date FROM enquiries WHERE vendor_id = ? AND (contact_handle = ? OR contact_email = ?) AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')",
        e.vendor_id, handle, handle,
      ).map((r) => (r.id === e.id ? details.event_date : r.event_date))
    : [];
  const hit = fishingSignal({
    inbound: inbound.map((m) => m.body),
    repliesAfterDateAsk: firstAsk ? inbound.filter((m) => m.id > firstAsk.id).length : 0,
    details,
    firstDetails: parseEnquiry(inbound[0]?.body ?? "", items, today),
    recentDates: recent,
  });
  if (!hit) return null;
  const now = nowIso();
  run("UPDATE enquiries SET fishing_reason = ? WHERE id = ?", hit.reason, e.id);
  run("INSERT INTO enquiry_flags (vendor_id, enquiry_id, kind, signal, reason, created_at) VALUES (?, ?, 'price_fishing', ?, ?, ?)", e.vendor_id, e.id, hit.signal, hit.reason, now);
  return hit.reason;
}

/** The vendor says it's a real enquiry: clear the flag for good on this enquiry. */
export function clearFishingFlag(vendorId: number, enquiryId: number) {
  if (!getEnquiry(vendorId, enquiryId)) throw new Error("Enquiry not found");
  tx(() => {
    run("UPDATE enquiries SET fishing_reason = NULL, fishing_cleared = 1, owner_reason = NULL WHERE id = ?", enquiryId);
    run("UPDATE enquiry_flags SET cleared_at = ? WHERE enquiry_id = ? AND cleared_at IS NULL", nowIso(), enquiryId);
  });
}

/** How many enquiries were flagged as possible price-fishing (cleared ones included). */
export const countFishingFlags = (vendorId: number) =>
  get<{ n: number }>("SELECT COUNT(*) n FROM enquiry_flags WHERE vendor_id = ? AND kind = 'price_fishing'", vendorId)!.n;

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

function leadScore(d: Details, q: Quote | null, available: boolean | null, missing: string[], overCap: boolean): "hot" | "warm" | "cold" {
  if (overCap || available === false) return "cold";
  if (q && d.budget && d.budget < q.total * 0.7) return "cold";
  if (!missing.length && q && q.lines.length && (!d.budget || d.budget >= q.total * 0.9)) return "hot";
  return "warm";
}

export interface ProcessResult {
  enquiryId: number;
  draftId: number | null;
  autoSent: boolean;
  ownerReason: string | null;
  usedAI: boolean;
}

/** Understand the conversation so far, price it, and draft the next reply. */
export async function processEnquiry(vendorId: number, enquiryId: number): Promise<ProcessResult> {
  const startedAt = nowIso();
  const vendor = getVendor(vendorId);
  const e = getEnquiry(vendorId, enquiryId);
  if (!vendor || !e) throw new Error("Enquiry not found");
  const items = getItems(vendorId);
  const msgs = getMessages(enquiryId);
  const prev = e.details && e.details !== "{}" ? parseDetails(e) : null;
  const inbound = msgs.filter((m) => m.direction === "in");
  const isFirst = inbound.length <= 1 && !msgs.some((m) => m.direction === "out" && m.status !== "discarded" && m.status !== "draft");
  const today = sgToday();

  let usedAI = false;
  let details: Details;
  let aiError: string | null = null;
  if (aiEnabled()) {
    try {
      details = await aiExtract({ vendor, items, messages: msgs, previous: prev, today });
      details = mergeDetails(prev, details);
      usedAI = true;
    } catch (err) {
      aiError = err instanceof Error ? err.message : String(err);
      details = mergeDetails(prev, parseEnquiry(inbound.map((m) => m.body).join("\n"), items, today));
    }
  } else {
    details = mergeDetails(prev, parseEnquiry(inbound.map((m) => m.body).join("\n"), items, today));
    // The rules-based reader only sees the latest message's intent, and a date in it replaces the earlier one.
    if (!isFirst && inbound.length) {
      const latest = parseEnquiry(inbound[inbound.length - 1].body, items, today);
      details.intent = latest.intent;
      if (latest.event_date) Object.assign(details, { event_date: latest.event_date, date_text: latest.date_text, date_is_approximate: latest.date_is_approximate });
    }
  }
  // "Sunday works": the planner took one of the dates we offered.
  if (!isFirst && prev?.alternatives?.length && inbound.length) {
    const pick = pickAlternative(inbound[inbound.length - 1].body, prev.alternatives);
    if (pick) Object.assign(details, { event_date: pick, date_text: formatDate(pick), date_is_approximate: false, alternatives: [] });
  }
  if (isFirst) details.intent = "new_enquiry";
  if (!details.contact_name && e.contact_name) details.contact_name = e.contact_name.split(" ")[0];

  const fishing = e.fishing_reason ?? (e.fishing_cleared ? null : checkFishing(e, msgs, details, items, today));

  const pkg = items.find((i) => i.id === details.package_id && i.active) ?? null;
  const addons = items.filter((i) => details.addon_ids.includes(i.id) && i.active && i.kind === "addon");
  // No price until the enquiry is qualified (or the vendor said "Send price anyway").
  const qual = qualification(details, requiredFields(vendor.qualify_fields));
  const quotable = qual.qualified || !!e.price_override;
  // Brief mode (for the vendor, or for an item marked "Always quote manually"): the vendor writes the quote.
  const briefMode = vendor.pricing_mode === "brief" || [pkg, ...addons].some((i) => i?.manual_quote);
  const dateBooked = !!details.event_date && !details.date_is_approximate && availability(vendor, details.event_date, enquiryId).available === false;
  const quote = pkg && quotable && !briefMode && !dateBooked ? buildQuote({ vendor, pkg, addons, hours: details.hours, pax: details.pax, date: details.event_date, slot: details.slot }) : null;
  const avail = details.event_date ? availability(vendor, details.event_date, enquiryId) : null;
  const available = avail ? avail.available : null;
  const overCap = Boolean(vendor.capacity && details.pax && details.pax > vendor.capacity);
  const missing = missingFields(vendor, details, pkg);

  let purpose: DraftFacts["purpose"] = "quote";
  const reasons: string[] = [];
  if (details.intent === "declines") purpose = "answer";
  else if (details.intent === "accepts_quote" && !isFirst && (e.status === "quoted" || e.status === "expired")) { purpose = "confirm"; reasons.push("Planner wants to book: confirm the deposit and booking."); }
  else if (overCap) { purpose = "over_capacity"; reasons.push(`${details.pax} guests is over your ${vendor.capacity} capacity. Consider referring to a partner.`); }
  else if (available === false && !details.date_is_approximate) { purpose = "unavailable"; reasons.push(`You're fully booked on ${formatDate(details.event_date)}. Offer another date or refer to a partner.`); }
  else if (!quotable) purpose = "qualify";
  else if (briefMode) {
    purpose = e.brief_status ? "answer" : "brief";
    if (e.brief_status === "waiting") reasons.push(`Brief mode: the planner is waiting for your tailored quote${e.brief_due_at ? ` (promised by ${formatDateTime(e.brief_due_at)})` : ""}.`);
    else if (e.brief_status === "quoted") reasons.push("Brief mode: you wrote this quote, so Matchire won't add prices. Check the reply.");
  }
  else if (!pkg) { purpose = "ask_info"; reasons.push("No package on your price list fits this enquiry."); }
  else if (missing.length) purpose = "ask_info";
  // A new date ("could we do the 5th instead?") gets a fresh quote, not just an answer.
  else if (!isFirst && details.intent === "question" && details.event_date === (prev?.event_date ?? null)) purpose = "answer";

  const partners = vendor.bundle_suggestions && purpose === "quote" && details.event_type && details.event_type !== "other"
    ? acceptedPartners(vendorId).filter((p) => p.kind !== vendor.kind).slice(0, 2)
    : [];
  // Date booked: nearby free dates, and a partner in the same category who may be free that day.
  let alternatives: string[] = [];
  let fixedDatePartner: DraftFacts["fixedDatePartner"] = null;
  let fixedDatePrice: number | null = null;
  if (purpose === "unavailable" && details.event_date) {
    alternatives = alternativeDates(vendor, details.event_date, enquiryId, 2, today);
    details.alternatives = alternatives;
    const same = vendor.bundle_suggestions ? acceptedPartners(vendorId).find((p) => p.kind === vendor.kind) : undefined;
    if (same) {
      const pv = partnerView(same);
      fixedDatePartner = pv.view.from_price ? pv.view : "unnamed";
      fixedDatePrice = pv.price;
    }
  }
  const shared = partners.map(partnerView);
  const partnerSuggestions = shared.map((s) => s.view);
  const partnerPrices = shared.flatMap((s) => (s.price != null ? [s.price] : []));
  if (fixedDatePrice != null) partnerPrices.push(fixedDatePrice);

  // A brief holds the date as soon as it's free; a quote waits until nothing's missing.
  const draftedAt = nowIso();
  const willHold = available === true && !details.date_is_approximate && (purpose === "brief" || (purpose === "quote" && missing.length === 0));
  const facts: DraftFacts = {
    purpose,
    details,
    quote,
    available,
    missing: purpose === "qualify" ? [qualifyQuestion(qual.missing)]
      : purpose === "brief" ? briefAsks(details, vendor, msgs.filter((m) => m.direction === "out" && m.status !== "draft").map((m) => m.body))
      : missing,
    briefHours: vendor.brief_hours,
    alternatives: alternatives.length ? [formatDateChoice(alternatives)] : [],
    fixedDatePartner,
    askedPrice: purpose === "qualify" && inbound.some((m) => asksPrice(m.body)),
    holdHours: willHold ? vendor.hold_hours : null,
    holdText: willHold && purpose === "quote" ? holdSentence(holdUntil(draftedAt, vendor.hold_hours)) : null,
    depositText: quote && (purpose === "quote" || purpose === "confirm") ? depositLine(vendor, quote.total)?.text ?? null : null,
    upsellText: purpose === "quote" && pkg && quote ? upsellFor(pkg, items, addons, { vendor, pax: details.pax, date: details.event_date, slot: details.slot })?.text ?? null : null,
    partnerSuggestions,
    referredTo: null,
    depositNote: vendor.deposit_note,
  };

  if (quote?.issues.length) reasons.push(...quote.issues);
  if (details.needs_owner && details.owner_reason) reasons.push(details.owner_reason);
  // Never an automatic price for a possible price-fisher; the planner is never told.
  if (fishing) reasons.push(`Possible price-fishing: ${fishing}. Check this reply before it goes out.`);
  if (aiError) reasons.push(`AI unavailable (${aiError}); drafted with the built-in template.`);

  let body = templateDraft(vendor, facts);
  if (usedAI) {
    try {
      // Before qualifying, the AI doesn't see the price list, and any amount at all sends it back to the template.
      const noPrices = purpose === "qualify" || briefMode;
      const draft = await aiDraft({ vendor, items: noPrices ? [] : items.filter((i) => !i.manual_quote), messages: msgs, facts });
      const polish = [quote ? depositLine(vendor, quote.total)?.amount : null, pkg && quote ? upsellFor(pkg, items, addons, { vendor, pax: details.pax, date: details.event_date, slot: details.slot })?.total : null].filter((x): x is number => x != null);
      const allowed = draftAllowedAmounts(noPrices ? "qualify" : purpose, quote, items, [...partnerPrices, ...polish, details.budget ?? 0, vendor.min_spend]);
      const bad = unknownAmounts(draft.reply, allowed);
      if (bad.length) {
        reasons.push(`The AI draft mentioned prices not on your list (${bad.map(fmtMoney).join(", ")}), so Matchire used the standard template instead.`);
      } else {
        body = normalizeReply(draft.reply.trim());
        if (draft.needs_owner && draft.owner_reason) reasons.push(draft.owner_reason);
      }
    } catch (err) {
      reasons.push(`AI drafting failed (${err instanceof Error ? err.message : String(err)}); used the built-in template.`);
    }
  } else if (details.questions.length && purpose === "answer") {
    reasons.push("The planner asked a question the template can't answer.");
  }

  const needsOwner = reasons.length > 0 || details.needs_owner || purpose === "confirm" || purpose === "answer";
  const lead = leadScore(details, quote, available, missing, overCap);
  const now = nowIso();

  const draftId = tx(() => {
    // The vendor answered from their WhatsApp app while this reply was being drafted: theirs stands.
    if (get("SELECT 1 FROM messages WHERE enquiry_id = ? AND purpose = 'phone_reply' AND created_at >= ?", enquiryId, startedAt)) return null;
    run("UPDATE messages SET status = 'discarded' WHERE enquiry_id = ? AND status = 'draft'", enquiryId);
    run(
      `UPDATE enquiries SET details = ?, quote = ?, lead = ?, event_date = ?, contact_name = COALESCE(contact_name, ?), owner_reason = ?,
       status = CASE WHEN ? = 'declines' THEN 'lost' ELSE status END, updated_at = ? WHERE id = ?`,
      JSON.stringify(details), quote ? JSON.stringify(quote) : null, lead, details.event_date, details.contact_name,
      needsOwner ? reasons.join(" ") || "Check this reply before it goes out." : null, details.intent, now, enquiryId,
    );
    if (purpose === "brief") run("UPDATE enquiries SET brief = ? WHERE id = ?", JSON.stringify(buildBrief(e, details, msgs, vendor, null, null)), enquiryId);
    if (details.intent === "declines") {
      run("UPDATE holds SET status = 'released' WHERE enquiry_id = ? AND status = 'active' AND kind = 'hold'", enquiryId);
      run("UPDATE enquiries SET next_followup_at = NULL WHERE id = ?", enquiryId);
    }
    return run("INSERT INTO messages (enquiry_id, direction, body, status, purpose, hold_until, created_at) VALUES (?, 'out', ?, 'draft', ?, ?, ?)",
      enquiryId, body, purpose, facts.holdText ? holdUntil(draftedAt, vendor.hold_hours) : null, now);
  });

  if (draftId === null) return { enquiryId, draftId, autoSent: false, ownerReason: null, usedAI };
  let autoSent = false;
  if (vendor.auto_send && !needsOwner) {
    const r = await sendDraft(vendorId, draftId);
    autoSent = r.status === "sent";
  }
  return { enquiryId, draftId, autoSent, ownerReason: needsOwner ? reasons.join(" ") : null, usedAI };
}

// ---------- Sending ----------

export async function sendDraft(vendorId: number, messageId: number, opts: { body?: string; markBooked?: boolean; now?: string } = {}) {
  const m = get<Message & { vendor_id: number }>(
    "SELECT m.*, e.vendor_id FROM messages m JOIN enquiries e ON e.id = m.enquiry_id WHERE m.id = ?",
    messageId,
  );
  if (!m || m.vendor_id !== vendorId) throw new Error("Message not found");
  if (m.status !== "draft") throw new Error("This reply was already handled");
  const vendor = getVendor(vendorId)!;
  const e = getEnquiry(vendorId, m.enquiry_id)!;
  const now = opts.now ?? nowIso();
  const promised = promisedHold(vendor, m, (opts.body ?? m.body).trim(), now);
  let body = promised.body;

  // Follow-ups after WhatsApp's 24-hour window can only go out as approved templates.
  let template: Template | null = m.template ? JSON.parse(m.template) : null;
  if (!template) {
    const route = followupRoute(vendor, e, m.purpose ?? "", now, 0);
    if (route.kind === "closed") {
      run("UPDATE messages SET body = ? WHERE id = ?", body, messageId);
      run("UPDATE enquiries SET owner_reason = ? WHERE id = ?", route.reason, e.id);
      return { status: "manual", via: "WhatsApp", error: route.reason } satisfies SendResult;
    }
    if (route.kind === "template") template = route.template;
  }
  if (template) {
    body = template.body;
    const blocked = templateBlocked(vendor, e, template);
    if (blocked) {
      run("UPDATE messages SET body = ?, template = ? WHERE id = ?", body, JSON.stringify(template), messageId);
      run("UPDATE enquiries SET owner_reason = ? WHERE id = ?", blocked, e.id);
      return { status: "manual", via: "WhatsApp", error: blocked } satisfies SendResult;
    }
  }
  const result = template ? await deliverTemplate(vendor, e, template) : await deliver(vendor, e, body);

  if (result.status === "manual") {
    // Nothing went out. Keep the draft (with any edits) so the vendor can copy it and confirm.
    run("UPDATE messages SET body = ? WHERE id = ?", body, messageId);
    run("UPDATE enquiries SET owner_reason = ? WHERE id = ?", result.error ?? "Copy this reply and send it yourself.", e.id);
    return result;
  }
  tx(() => {
    run("UPDATE messages SET body = ?, template = ?, status = ?, error = ?, sent_at = ? WHERE id = ?", body, template ? JSON.stringify(template) : null, result.status, result.error ?? null, result.status === "failed" ? null : now, messageId);
    if (result.status === "failed") return;
    run("UPDATE enquiries SET first_response_at = COALESCE(first_response_at, ?), last_outbound_at = ?, owner_reason = NULL, updated_at = ? WHERE id = ?", now, now, now, e.id);
    afterSend(vendor, e, m.purpose ?? "quote", now, promised.until);
  });
  if (opts.markBooked && result.status === "sent") markBooked(vendorId, e.id);
  if (result.status === "sent") await afterSendAsync(vendor, e.id, m.purpose ?? "quote", body, now);
  return result;
}

/** What happens after a reply goes out that needs the network: the brief email, or spotting a quote the vendor wrote. */
async function afterSendAsync(vendor: Vendor, enquiryId: number, purpose: string, body: string, now: string) {
  const e = getEnquiry(vendor.id, enquiryId)!;
  if (purpose === "brief") await notifyVendor(vendor, e, "brief");
  else if (e.brief_status === "waiting" && looksLikeQuote(body)) markBriefQuoted(vendor.id, e.id, now);
}

/** A reply the vendor wrote with an amount in it ("SGD 1,200") is their quote. */
const looksLikeQuote = (body: string) => unknownAmounts(body, new Set()).length > 0;

/** Brief mode: the vendor sent their quote ("Quote sent", or a reply with a price). Follow-ups start now. */
export function markBriefQuoted(vendorId: number, enquiryId: number, now = nowIso()) {
  const vendor = getVendor(vendorId)!;
  const e = getEnquiry(vendorId, enquiryId);
  if (!e) throw new Error("Enquiry not found");
  const hold = get<{ id: number }>("SELECT id FROM holds WHERE enquiry_id = ? AND status = 'active' AND kind = 'hold'", e.id);
  const nudge = hoursFrom(now, hold ? Math.min(vendor.followup_days * 24, vendor.hold_hours / 2) : vendor.followup_days * 24);
  run(
    "UPDATE enquiries SET brief_status = 'quoted', status = 'quoted', followup_stage = 0, next_followup_at = ?, owner_reason = NULL, last_outbound_at = COALESCE(last_outbound_at, ?), updated_at = ? WHERE id = ?",
    nudgeTime(vendor, e, now, nudge), now, now, e.id,
  );
}

/** Email the vendor their brief (or a reminder that the quote is due). Demo accounts only pretend. */
export async function notifyVendor(vendor: Vendor, e: Enquiry, kind: "brief" | "reminder"): Promise<string | null> {
  const b: Brief | null = e.brief ? JSON.parse(e.brief) : null;
  if (!b) return null;
  const who = b.client;
  const subject = kind === "brief" ? `New brief: ${who}${b.date ? `, ${formatDate(b.date)}` : ""}` : `Quote due: ${who}${b.date ? `, ${formatDate(b.date)}` : ""}`;
  const intro = kind === "brief"
    ? `Matchire told ${who} you'll send a tailored quote${b.dueAt ? ` by ${formatDateTime(b.dueAt)}` : ""}. Here's the brief.`
    : `You promised ${who} a tailored quote by ${formatDateTime(b.dueAt)}, and it hasn't gone out yet.`;
  const link = `${(process.env.APP_URL || "https://app.matchire.ai").replace(/\/$/, "")}/app/inbox/${e.id}`;
  const text = `${intro}\n\n${briefText(b)}\n\nOpen it: ${link}\nWhen you've sent your quote, press "Quote sent" so the follow-ups start.`;
  const to = all<{ email: string }>("SELECT email FROM users WHERE vendor_id = ?", vendor.id).map((u) => u.email);
  if (vendor.is_demo) {
    console.log(`[demo] demo: not sent (${kind} email, enquiry ${e.id})`);
    return null;
  }
  let error: string | null = null;
  for (const addr of to) error = (await sendRawEmail({ to: addr, subject, text }).catch((x) => (x instanceof Error ? x.message : String(x)))) ?? error;
  if (error) console.warn(`[brief] ${kind} email for enquiry ${e.id} failed: ${error}`);
  return error;
}

const hoursFrom = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * 3600_000).toISOString();

// ---------- WhatsApp 24-hour window ----------
// WhatsApp only accepts free-form messages within 24 hours of the planner's
// last message. Follow-ups are timed to land inside that window where they
// can; otherwise they go out as pre-approved templates (see README).

export const NEEDS_TEMPLATE_APPROVAL = "Follow-up needs template approval";

/** Exactly as submitted to Meta (category UTILITY, language en). */
const FOLLOWUP_TEMPLATES: Record<string, { name: string; text: string }> = {
  followup: { name: "quote_nudge", text: "Hi {{1}}, just checking you saw our quote for {{2}}. Happy to answer any questions. Reply here anytime." },
  last_call: { name: "quote_last_call", text: "Hi {{1}}, we're holding {{2}} for you until {{3}}. Reply here if you'd like to confirm." },
};

type Template = WaTemplate & { body: string };
type Route = { kind: "text" } | { kind: "template"; template: Template } | { kind: "closed"; reason: string };

/** When free-form replies stop being allowed, or null if this enquiry isn't sent through the WhatsApp API. */
export function whatsappWindowEnd(vendor: Vendor, e: Enquiry): string | null {
  if (!viaWhatsAppApi(vendor, e)) return null;
  return hoursFrom(e.last_inbound_at ?? e.created_at, 24);
}

/** A nudge due after the window closes moves to an hour before it closes, if that's still at least 4h after the quote. */
function nudgeTime(vendor: Vendor, e: Enquiry, sentAt: string, due: string): string {
  const end = whatsappWindowEnd(vendor, e);
  if (!end) return due;
  const latest = hoursFrom(end, -1);
  if (due <= latest) return due;
  return latest >= hoursFrom(sentAt, 4) ? latest : due;
}

function followupTemplate(e: Enquiry, purpose: string): Template | null {
  const spec = FOLLOWUP_TEMPLATES[purpose];
  if (!spec || e.status !== "quoted") return null;
  const d = parseDetails(e);
  const first = (e.contact_name || d.contact_name || "").trim().split(/\s+/)[0] || "there";
  let params: string[];
  if (purpose === "followup") {
    params = [first, d.event_date && !d.date_is_approximate ? formatDate(d.event_date) : "your event"];
  } else {
    const hold = get<Hold>("SELECT * FROM holds WHERE enquiry_id = ? AND kind = 'hold' ORDER BY id DESC LIMIT 1", e.id);
    if (!hold?.expires_at) return null;
    params = [first, formatDate(hold.date), formatDateTime(hold.expires_at)];
  }
  return { name: spec.name, params, body: spec.text.replace(/\{\{(\d)\}\}/g, (_, i) => params[Number(i) - 1]) };
}

/** How a follow-up can go out at `now`. `marginHours` keeps a buffer before the window closes. A draft that waits
 *  for approval is checked again when it's sent, so a free-form draft sent too late still goes out as a template. */
function followupRoute(vendor: Vendor, e: Enquiry, purpose: string, now: string, marginHours: number): Route {
  if (purpose !== "followup" && purpose !== "last_call") return { kind: "text" };
  const end = whatsappWindowEnd(vendor, e);
  if (!end || now < hoursFrom(end, -marginHours)) return { kind: "text" };
  const template = followupTemplate(e, purpose);
  if (!template) return { kind: "closed", reason: "WhatsApp's 24-hour window has closed. Send this follow-up from your phone." };
  return { kind: "template", template };
}

/** The reason a template can't go out yet, or null if the vendor has it approved. */
function templateBlocked(vendor: Vendor, e: Enquiry, t: Template): string | null {
  if (vendor.wa_templates_approved) return null;
  console.warn(`[whatsapp] follow-up for enquiry ${e.id} not sent: template ${t.name} isn't marked approved for vendor ${vendor.id}`);
  return `${NEEDS_TEMPLATE_APPROVAL}. WhatsApp's 24-hour window has closed, so this goes out as the ${t.name} template. Once Meta approves it, tick "My follow-up templates are approved" in Settings and send.`;
}

/**
 * The hold a quote promised ("until Sun 1 Nov, 4pm"). If that time has passed
 * by the time it's sent, a new deadline replaces it in the text too, so the
 * planner is never told a time that doesn't match the hold.
 */
function promisedHold(vendor: Vendor, m: Message, body: string, now: string): { until: string | null; body: string } {
  if (!m.hold_until) return { until: null, body };
  if (m.hold_until > now) return { until: m.hold_until, body };
  const until = holdUntil(now, vendor.hold_hours);
  return { until, body: body.replace(holdSentence(m.hold_until), holdSentence(until)) };
}

function afterSend(vendor: Vendor, e: Enquiry, purpose: string, now: string, holdExpires: string | null = null) {
  const d = parseDetails(e);
  const followup = hoursFrom(now, vendor.followup_days * 24);
  switch (purpose) {
    case "quote": {
      const exact = d.event_date && !d.date_is_approximate;
      const has = get<{ id: number }>("SELECT id FROM holds WHERE enquiry_id = ? AND status = 'active'", e.id);
      let nudge = followup;
      if (exact && !has && availability(vendor, d.event_date!, e.id).available) {
        run("INSERT INTO holds (vendor_id, enquiry_id, date, kind, note, expires_at) VALUES (?, ?, ?, 'hold', ?, ?)",
          vendor.id, e.id, d.event_date!, e.contact_name || d.contact_name || "Enquiry", holdExpires ?? hoursFrom(now, vendor.hold_hours));
        // Nudge while the date is still held, so the planner can still act on it.
        nudge = hoursFrom(now, Math.min(vendor.followup_days * 24, vendor.hold_hours / 2));
      }
      run("UPDATE enquiries SET status = 'quoted', followup_stage = 0, next_followup_at = ? WHERE id = ?", nudgeTime(vendor, e, now, nudge), e.id);
      break;
    }
    case "brief": {
      const exact = d.event_date && !d.date_is_approximate;
      let hold: Hold | null = get<Hold>("SELECT * FROM holds WHERE enquiry_id = ? AND status = 'active'", e.id) ?? null;
      if (exact && !hold && availability(vendor, d.event_date!, e.id).available) {
        const id = run("INSERT INTO holds (vendor_id, enquiry_id, date, kind, note, expires_at) VALUES (?, ?, ?, 'hold', ?, ?)",
          vendor.id, e.id, d.event_date!, e.contact_name || d.contact_name || "Enquiry", hoursFrom(now, vendor.hold_hours));
        hold = get<Hold>("SELECT * FROM holds WHERE id = ?", id)!;
      }
      const due = hoursFrom(now, vendor.brief_hours);
      const brief = buildBrief(e, d, getMessages(e.id), vendor, hold, due);
      // No planner follow-ups until the vendor's quote is out; the vendor gets reminded instead.
      run("UPDATE enquiries SET status = 'awaiting_info', brief = ?, brief_status = 'waiting', brief_due_at = ?, brief_reminded_at = NULL, next_followup_at = NULL WHERE id = ?", JSON.stringify(brief), due, e.id);
      run("INSERT INTO messages (enquiry_id, direction, body, status, created_at) VALUES (?, 'note', ?, 'sent', ?)", e.id, `Brief for your quote (due ${formatDateTime(due)}):\n\n${briefText(brief)}`, now);
      break;
    }
    case "ask_info":
    case "qualify":
      run("UPDATE enquiries SET status = 'awaiting_info', followup_stage = 0, next_followup_at = ? WHERE id = ?", nudgeTime(vendor, e, now, followup), e.id);
      break;
    case "answer":
      if (e.status === "new") run("UPDATE enquiries SET status = 'awaiting_info' WHERE id = ?", e.id);
      break;
    case "followup": {
      const hold = get<Hold>("SELECT * FROM holds WHERE enquiry_id = ? AND status = 'active' AND kind = 'hold'", e.id);
      const lastCall = hold?.expires_at ? hoursFrom(hold.expires_at, -Math.min(12, vendor.hold_hours / 4)) : null;
      run("UPDATE enquiries SET followup_stage = 1, next_followup_at = ? WHERE id = ?", lastCall && lastCall > now ? lastCall : null, e.id);
      break;
    }
    case "last_call":
      run("UPDATE enquiries SET followup_stage = 2, next_followup_at = NULL WHERE id = ?", e.id);
      break;
    case "unavailable":
      // Not lost: we offered other dates. It stays open (and isn't counted as quoted) until the planner answers.
      run("UPDATE enquiries SET status = 'awaiting_info', next_followup_at = NULL WHERE id = ?", e.id);
      break;
    case "over_capacity":
      run("UPDATE enquiries SET status = 'lost', next_followup_at = NULL WHERE id = ?", e.id);
      break;
    case "referred":
      run("UPDATE enquiries SET status = 'referred', next_followup_at = NULL WHERE id = ?", e.id);
      break;
  }
}

/** Mark a draft as sent by hand (the vendor copied it into WhatsApp themselves). */
export function markDraftSentManually(vendorId: number, messageId: number, body?: string) {
  const m = get<Message & { vendor_id: number }>("SELECT m.*, e.vendor_id FROM messages m JOIN enquiries e ON e.id = m.enquiry_id WHERE m.id = ?", messageId);
  if (!m || m.vendor_id !== vendorId || m.status !== "draft") throw new Error("Message not found");
  const vendor = getVendor(vendorId)!;
  const e = getEnquiry(vendorId, m.enquiry_id)!;
  const now = nowIso();
  const promised = promisedHold(vendor, m, (body ?? m.body).trim(), now);
  const text = promised.body;
  tx(() => {
    run("UPDATE messages SET body = ?, status = 'manual', error = NULL, sent_at = ? WHERE id = ?", text, now, messageId);
    run("UPDATE enquiries SET first_response_at = COALESCE(first_response_at, ?), last_outbound_at = ?, owner_reason = NULL, updated_at = ? WHERE id = ?", now, now, now, e.id);
    afterSend(vendor, e, m.purpose ?? "quote", now, promised.until);
  });
  // The state above is already saved; this only sends the brief email (await it to know it went).
  return afterSendAsync(vendor, e.id, m.purpose ?? "quote", text, now);
}

export function discardDraft(vendorId: number, messageId: number) {
  const m = get<{ vendor_id: number; enquiry_id: number }>("SELECT e.vendor_id, m.enquiry_id FROM messages m JOIN enquiries e ON e.id = m.enquiry_id WHERE m.id = ?", messageId);
  if (!m || m.vendor_id !== vendorId) throw new Error("Message not found");
  run("UPDATE messages SET status = 'discarded' WHERE id = ? AND status = 'draft'", messageId);
  run("UPDATE enquiries SET owner_reason = NULL WHERE id = ?", m.enquiry_id);
}

// ---------- Outcomes ----------

export function markBooked(vendorId: number, enquiryId: number, value?: number) {
  const e = getEnquiry(vendorId, enquiryId);
  if (!e) throw new Error("Enquiry not found");
  const vendor = getVendor(vendorId)!;
  const q = parseQuote(e);
  const d = parseDetails(e);
  const amount = value ?? q?.total ?? null;
  tx(() => {
    run("UPDATE enquiries SET status = 'won', won_value = ?, next_followup_at = NULL, owner_reason = NULL, updated_at = ? WHERE id = ?", amount, nowIso(), enquiryId);
    const hold = get<Hold>("SELECT * FROM holds WHERE enquiry_id = ? AND status = 'active'", enquiryId);
    if (hold) run("UPDATE holds SET kind = 'booking', expires_at = NULL WHERE id = ?", hold.id);
    else if (d.event_date) run("INSERT INTO holds (vendor_id, enquiry_id, date, kind, note) VALUES (?, ?, ?, 'booking', ?)", vendor.id, enquiryId, d.event_date, e.contact_name || "Booking");
    const ref = get<{ id: number; fee_pct: number }>("SELECT id, fee_pct FROM referrals WHERE target_enquiry = ? AND status = 'open'", enquiryId);
    if (ref) run("UPDATE referrals SET status = 'won', fee_amount = ? WHERE id = ?", amount != null ? Math.round(amount * ref.fee_pct) / 100 : null, ref.id);
  });
}

export function markLost(vendorId: number, enquiryId: number) {
  if (!getEnquiry(vendorId, enquiryId)) throw new Error("Enquiry not found");
  tx(() => {
    run("UPDATE enquiries SET status = 'lost', next_followup_at = NULL, owner_reason = NULL, updated_at = ? WHERE id = ?", nowIso(), enquiryId);
    run("UPDATE holds SET status = 'released' WHERE enquiry_id = ? AND status = 'active' AND kind = 'hold'", enquiryId);
    run("UPDATE messages SET status = 'discarded' WHERE enquiry_id = ? AND status = 'draft'", enquiryId);
    run("UPDATE referrals SET status = 'lost' WHERE target_enquiry = ? AND status = 'open'", enquiryId);
  });
}

/**
 * Permanently delete an enquiry. Its messages, quote, date holds and referral
 * links go with it (ON DELETE CASCADE). A copy referred to a partner stays in
 * the partner's inbox: it's their record now.
 */
export function deleteEnquiry(vendorId: number, enquiryId: number) {
  if (!getEnquiry(vendorId, enquiryId)) throw new Error("Enquiry not found");
  run("DELETE FROM enquiries WHERE id = ? AND vendor_id = ?", enquiryId, vendorId);
}

/** "Send price anyway": quote this enquiry even though it isn't qualified yet. */
export async function sendPriceAnyway(vendorId: number, enquiryId: number) {
  if (!getEnquiry(vendorId, enquiryId)) throw new Error("Enquiry not found");
  run("UPDATE enquiries SET price_override = 1 WHERE id = ?", enquiryId);
  return processEnquiry(vendorId, enquiryId);
}

export function reopen(vendorId: number, enquiryId: number) {
  if (!getEnquiry(vendorId, enquiryId)) throw new Error("Enquiry not found");
  run("UPDATE enquiries SET status = 'quoted', updated_at = ? WHERE id = ?", nowIso(), enquiryId);
}

/** Log a planner message the vendor received elsewhere (or is testing with) on an existing enquiry. */
export function appendInbound(vendorId: number, enquiryId: number, text: string) {
  const e = getEnquiry(vendorId, enquiryId);
  if (!e) throw new Error("Enquiry not found");
  const now = nowIso();
  tx(() => {
    run("INSERT INTO messages (enquiry_id, direction, body, status, created_at) VALUES (?, 'in', ?, 'sent', ?)", enquiryId, text.trim(), now);
    run(
      "UPDATE enquiries SET last_inbound_at = ?, next_followup_at = NULL, status = CASE WHEN status = 'expired' THEN 'quoted' ELSE status END, updated_at = ? WHERE id = ?",
      now, now, enquiryId,
    );
  });
}

export function addNote(vendorId: number, enquiryId: number, body: string) {
  if (!getEnquiry(vendorId, enquiryId)) throw new Error("Enquiry not found");
  run("INSERT INTO messages (enquiry_id, direction, body, status) VALUES (?, 'note', ?, 'sent')", enquiryId, body.trim());
}

// ---------- Partner referrals ----------

export async function referToPartner(vendorId: number, enquiryId: number, partnerId: number) {
  const vendor = getVendor(vendorId)!;
  const e = getEnquiry(vendorId, enquiryId);
  const partner = acceptedPartners(vendorId).find((p) => p.id === partnerId);
  if (!e || !partner) throw new Error("Partner not found");
  const inbound = getMessages(enquiryId).filter((m) => m.direction === "in").map((m) => m.body).join("\n\n");
  const d = parseDetails(e);

  const { enquiryId: targetId } = ingest({
    vendorId: partner.id,
    channel: "referral",
    text: `${inbound}\n\n(Referred by ${vendor.name})`,
    name: e.contact_name,
    handle: e.contact_handle,
    email: e.contact_email,
    referredFrom: vendor.id,
  });
  tx(() => {
    run("INSERT INTO referrals (from_vendor, to_vendor, source_enquiry, target_enquiry, fee_pct) VALUES (?, ?, ?, ?, ?)", vendor.id, partner.id, enquiryId, targetId, vendor.referral_fee_pct);
    run("UPDATE holds SET status = 'released' WHERE enquiry_id = ? AND status = 'active' AND kind = 'hold'", enquiryId);
    run("UPDATE messages SET status = 'discarded' WHERE enquiry_id = ? AND status = 'draft'", enquiryId);
    const body = templateDraft(vendor, {
      purpose: "referred", details: d, quote: null, available: null, missing: [], holdHours: null,
      partnerSuggestions: [], referredTo: partner.name, depositNote: "",
    });
    run("INSERT INTO messages (enquiry_id, direction, body, status, purpose) VALUES (?, 'out', ?, 'draft', 'referred')", enquiryId, body);
    run("UPDATE enquiries SET owner_reason = ?, updated_at = ? WHERE id = ?", `Referred to ${partner.name}. Let the planner know.`, nowIso(), enquiryId);
  });
  await processEnquiry(partner.id, targetId).catch(() => null);
  return targetId;
}

// ---------- Calendar ----------

export function blockDate(vendorId: number, date: string, note: string) {
  run("INSERT INTO holds (vendor_id, date, kind, note) VALUES (?, ?, 'block', ?)", vendorId, date, note.trim() || "Unavailable");
}

export function releaseHold(vendorId: number, holdId: number) {
  const h = get<Hold>("SELECT * FROM holds WHERE id = ? AND vendor_id = ?", holdId, vendorId);
  if (!h) throw new Error("Not found");
  run("UPDATE holds SET status = 'released' WHERE id = ?", holdId);
  if (h.enquiry_id && h.kind === "hold") run("UPDATE enquiries SET next_followup_at = NULL WHERE id = ? AND status = 'quoted'", h.enquiry_id);
}

// ---------- Scheduler ----------

let ticking = false;

/** Expire stale holds and queue follow-ups. Runs every minute in-process and via /api/cron. */
export async function tick(now: string = nowIso()) {
  if (ticking) return { expired: 0, followups: 0, backup: null };
  ticking = true;
  try {
    const expired = all<Hold>("SELECT * FROM holds WHERE kind = 'hold' AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?", now);
    for (const h of expired) {
      tx(() => {
        run("UPDATE holds SET status = 'expired' WHERE id = ?", h.id);
        if (h.enquiry_id) {
          run("INSERT INTO messages (enquiry_id, direction, body, status) VALUES (?, 'note', ?, 'sent')", h.enquiry_id, `Hold on ${formatDate(h.date)} expired and the date was released.`);
          run("UPDATE enquiries SET status = 'expired', next_followup_at = NULL WHERE id = ? AND status = 'quoted' AND (last_inbound_at IS NULL OR last_inbound_at <= last_outbound_at)", h.enquiry_id);
        }
      });
    }

    const due = all<Enquiry>("SELECT * FROM enquiries WHERE status IN ('quoted','awaiting_info') AND next_followup_at IS NOT NULL AND next_followup_at <= ?", now);
    let followups = 0;
    for (const e of due) {
      const vendor = getVendor(e.vendor_id);
      if (!vendor) continue;
      run("UPDATE enquiries SET next_followup_at = NULL WHERE id = ?", e.id);
      if (pendingDraft(e.id)) continue;
      const purpose = e.followup_stage === 0 ? "followup" : "last_call";
      const hasHold = get<{ id: number }>("SELECT id FROM holds WHERE enquiry_id = ? AND status = 'active' AND kind = 'hold'", e.id);
      if (purpose === "last_call" && !hasHold) continue;
      const route = followupRoute(vendor, e, purpose, now, 5 / 60);
      const template = route.kind === "template" ? route.template : null;
      const body = template?.body ?? templateDraft(vendor, {
        purpose, details: parseDetails(e), quote: parseQuote(e), available: null, missing: [], holdHours: null,
        partnerSuggestions: [], referredTo: null, depositNote: "", quoteSent: e.status === "quoted",
      });
      const id = run("INSERT INTO messages (enquiry_id, direction, body, status, purpose, template) VALUES (?, 'out', ?, 'draft', ?, ?)", e.id, body, purpose, template ? JSON.stringify(template) : null);
      followups++;
      const blocked = route.kind === "closed" ? route.reason : template ? templateBlocked(vendor, e, template) : null;
      if (blocked) run("UPDATE enquiries SET owner_reason = ? WHERE id = ?", blocked, e.id);
      else if (vendor.auto_send && !e.fishing_reason) await sendDraft(vendor.id, id, { now }).catch(() => null);
      else if (e.fishing_reason) run("UPDATE enquiries SET owner_reason = ? WHERE id = ?", `Possible price-fishing: ${e.fishing_reason}. Check this follow-up before it goes out.`, e.id);
      else run("UPDATE enquiries SET owner_reason = ? WHERE id = ?", purpose === "followup" ? "Follow-up ready: the planner hasn't replied." : "Last call before the hold expires.", e.id);
    }
    // Brief mode: remind the vendor (never the planner) when a promised quote is late.
    const late = all<Enquiry>("SELECT * FROM enquiries WHERE brief_status = 'waiting' AND brief_due_at IS NOT NULL AND brief_due_at <= ? AND brief_reminded_at IS NULL", now);
    for (const e of late) {
      const vendor = getVendor(e.vendor_id);
      if (!vendor) continue;
      run("UPDATE enquiries SET brief_reminded_at = ?, owner_reason = ? WHERE id = ?", now, `Your tailored quote was due ${formatDateTime(e.brief_due_at)}. Send it, then press "Quote sent".`, e.id);
      run("INSERT INTO messages (enquiry_id, direction, body, status, created_at) VALUES (?, 'note', ?, 'sent', ?)", e.id, `Reminder: the quote you promised was due ${formatDateTime(e.brief_due_at)}.`, now);
      await notifyVendor(vendor, e, "reminder").catch(() => null);
    }
    // The day's backup, once it's past 3 am in Singapore.
    const backup = await maybeDailyBackup(new Date(now)).catch((e) => {
      console.error("Daily backup failed", e);
      return null;
    });
    if (backup?.email_error) console.warn(`[backup] ${backup.file} saved, but not emailed: ${backup.email_error}`);
    return { expired: expired.length, followups, backup: backup?.file ?? null };
  } finally {
    ticking = false;
  }
}

// ---------- Dashboard ----------

export function stats(vendorId: number, days = 30) {
  const since = `-${days} days`;
  const rows = all<Enquiry>("SELECT * FROM enquiries WHERE vendor_id = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)", vendorId, since);
  const responseMins = rows
    .filter((e) => e.first_response_at)
    .map((e) => (new Date(e.first_response_at!).getTime() - new Date(e.created_at).getTime()) / 60000)
    .sort((a, b) => a - b);
  const median = responseMins.length ? responseMins[Math.floor(responseMins.length / 2)] : null;
  const won = rows.filter((e) => e.status === "won");
  const quoted = rows.filter((e) => e.quote && e.first_response_at);
  const byChannel = new Map<string, { total: number; won: number; value: number }>();
  for (const e of rows) {
    const c = byChannel.get(e.channel) ?? { total: 0, won: 0, value: 0 };
    c.total++;
    if (e.status === "won") { c.won++; c.value += e.won_value ?? 0; }
    byChannel.set(e.channel, c);
  }
  const referralFees = get<{ s: number | null }>("SELECT SUM(fee_amount) s FROM referrals WHERE from_vendor = ? AND status = 'won'", vendorId)?.s ?? 0;
  return {
    enquiries: rows.length,
    medianResponseMins: median,
    quotesSent: quoted.length,
    booked: won.length,
    bookedValue: won.reduce((s, e) => s + (e.won_value ?? 0), 0),
    conversion: rows.length ? won.length / rows.length : 0,
    byChannel: [...byChannel.entries()].map(([channel, v]) => ({ channel, ...v })).sort((a, b) => b.total - a.total),
    referralFees,
  };
}
