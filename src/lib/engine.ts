import { all, get, run, tx, nowIso } from "./db.ts";
import type { Channel, Details, Enquiry, Hold, Item, Message, Quote, Vendor } from "./types.ts";
import { EMPTY_DETAILS, OPEN_STATUSES, VENDOR_KINDS } from "./types.ts";
import { buildQuote, allowedAmounts, unknownAmounts, fmtMoney } from "./pricing.ts";
import { parseEnquiry } from "./heuristics.ts";
import { aiEnabled, aiExtract, aiDraft, type DraftFacts } from "./ai.ts";
import { formatDate, sgToday } from "./dates.ts";
import { deliver } from "./channels.ts";

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

export function acceptedPartners(vendorId: number): Vendor[] {
  return all<Vendor>(
    `SELECT v.* FROM partnerships p JOIN vendors v ON v.id = CASE WHEN p.requester_id = ? THEN p.partner_id ELSE p.requester_id END
     WHERE (p.requester_id = ? OR p.partner_id = ?) AND p.status = 'accepted' ORDER BY v.name`,
    vendorId, vendorId, vendorId,
  );
}

/** A partner's cheapest live package, with its unit ("/pax", "/hour"). */
function fromPrice(vendorId: number): { price: number; unit: string } | null {
  const r = get<{ price: number; pricing: string }>("SELECT price, pricing FROM items WHERE vendor_id = ? AND kind = 'package' AND active = 1 ORDER BY price LIMIT 1", vendorId);
  return r ? { price: r.price, unit: r.pricing === "per_pax" ? "/pax" : r.pricing === "per_hour" ? "/hour" : "" } : null;
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
  return `${lines.join("\n")}\nTotal: ${fmtMoney(q.total)}`;
}

/** Deterministic reply used without an API key, and whenever a model draft fails a check. */
export function templateDraft(vendor: Vendor, f: DraftFacts): string {
  const d = f.details;
  const hi = `Hi${d.contact_name ? ` ${d.contact_name}` : ""}! `;
  const sign = `\n\nThanks,\n${vendor.signoff || vendor.name}`;
  const when = d.event_date ? `${formatDate(d.event_date)}${d.slot && d.slot !== "full_day" ? ` ${d.slot}` : ""}` : "";
  const ask = f.missing.length ? `\n\nCould you share ${f.missing.join(" and ")}? Then I'll confirm availability.` : "";
  switch (f.purpose) {
    case "over_capacity":
      return `${hi}Thanks for reaching out to ${vendor.name} 😊\n\nOur space fits up to ${vendor.capacity} guests, so ${d.pax} would be too many for us. I'd be happy to introduce a partner venue that fits your group.${sign}`;
    case "unavailable":
      return `${hi}Thanks for reaching out to ${vendor.name} 😊\n\nUnfortunately we're fully booked on ${when || "that date"}. Would another date work for you? I can also introduce a trusted partner who may be free.${sign}`;
    case "referred":
      return `${hi}Thanks for thinking of ${vendor.name}! We're not able to take ${when || "this booking"}, so I've passed your details to our trusted partner ${f.referredTo}, who'll be in touch with you shortly.${sign}`;
    case "confirm":
      return `${hi}Wonderful, thank you! 🎉 We'd love to have you on ${when || "your date"}.${f.quote ? `\n\nTotal: ${fmtMoney(f.quote.total)}` : ""}\n\n${f.depositNote || "I'll send the deposit details shortly to lock in your booking."}${sign}`;
    case "followup":
      return `${hi}Just checking in on the quote for ${when || "your event"}${f.quote ? ` (${fmtMoney(f.quote.total)})` : ""}. Happy to adjust anything, or answer any questions. Shall I keep the date for you?${sign}`;
    case "last_call":
      return `${hi}A quick heads-up: I'm holding ${when || "your date"} for you until tomorrow, after which it opens up for other enquiries. Just reply "yes" if you'd like to go ahead!${sign}`;
    case "answer":
    case "ask_info":
    case "quote":
    default: {
      let r = `${hi}Thanks for reaching out to ${vendor.name} 😊\n\n`;
      if (f.available && when && !d.date_is_approximate) r += `Good news, we're available ${when}. `;
      if (f.quote && f.quote.lines.length) r += `Here's your quote:\n${quoteText(f.quote)}`;
      if (f.quote?.offpeak) r += `\n(includes our weekday daytime rate)`;
      if (f.partnerSuggestions.length) r += `\n\nPlanning the rest of the event? Our partners ${f.partnerSuggestions.join(" and ")}.`;
      r += ask;
      if (!f.missing.length && f.holdHours) r += `\n\nI've pencilled in the date for you for ${f.holdHours} hours. Shall I go ahead and confirm?`;
      if (d.questions.length && f.purpose === "answer") r += `\n\nI'll check on your question and get back to you shortly.`;
      return r + sign;
    }
  }
}

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
    // The rules-based reader only sees the latest message's intent.
    if (!isFirst && inbound.length) details.intent = parseEnquiry(inbound[inbound.length - 1].body, items, today).intent;
  }
  if (isFirst) details.intent = "new_enquiry";
  if (!details.contact_name && e.contact_name) details.contact_name = e.contact_name.split(" ")[0];

  const pkg = items.find((i) => i.id === details.package_id && i.active) ?? null;
  const addons = items.filter((i) => details.addon_ids.includes(i.id) && i.active && i.kind === "addon");
  const quote = pkg ? buildQuote({ vendor, pkg, addons, hours: details.hours, pax: details.pax, date: details.event_date, slot: details.slot }) : null;
  const avail = details.event_date ? availability(vendor, details.event_date, enquiryId) : null;
  const available = avail ? avail.available : null;
  const overCap = Boolean(vendor.capacity && details.pax && details.pax > vendor.capacity);
  const missing = missingFields(vendor, details, pkg);

  let purpose: DraftFacts["purpose"] = "quote";
  const reasons: string[] = [];
  if (details.intent === "declines") purpose = "answer";
  else if (details.intent === "accepts_quote" && !isFirst) { purpose = "confirm"; reasons.push("Planner wants to book: confirm the deposit and booking."); }
  else if (overCap) { purpose = "over_capacity"; reasons.push(`${details.pax} guests is over your ${vendor.capacity} capacity. Consider referring to a partner.`); }
  else if (available === false && !details.date_is_approximate) { purpose = "unavailable"; reasons.push(`You're fully booked on ${formatDate(details.event_date)}. Offer another date or refer to a partner.`); }
  else if (!pkg) { purpose = "ask_info"; reasons.push("No package on your price list fits this enquiry."); }
  else if (missing.length) purpose = "ask_info";
  else if (!isFirst && details.intent === "question") purpose = "answer";

  const partners = vendor.bundle_suggestions && purpose === "quote" && details.event_type && details.event_type !== "other"
    ? acceptedPartners(vendorId).filter((p) => p.kind !== vendor.kind).slice(0, 2)
    : [];
  const partnerPrices = partners.map((p) => fromPrice(p.id));
  const partnerSuggestions = partners.map((p, i) => {
    const fp = partnerPrices[i];
    return `${p.name} (${kindLabel(p.kind).toLowerCase()}${fp ? `, from ${fmtMoney(fp.price)}${fp.unit}` : ""})`;
  });

  const willHold = purpose === "quote" && available === true && !details.date_is_approximate && missing.length === 0;
  const facts: DraftFacts = {
    purpose,
    details,
    quote,
    available,
    missing,
    holdHours: willHold ? vendor.hold_hours : null,
    partnerSuggestions,
    referredTo: null,
    depositNote: vendor.deposit_note,
  };

  if (quote?.issues.length) reasons.push(...quote.issues);
  if (details.needs_owner && details.owner_reason) reasons.push(details.owner_reason);
  if (aiError) reasons.push(`AI unavailable (${aiError}); drafted with the built-in template.`);

  let body = templateDraft(vendor, facts);
  if (usedAI) {
    try {
      const draft = await aiDraft({ vendor, items, messages: msgs, facts });
      const allowed = allowedAmounts(quote, items, [...partnerPrices.flatMap((p) => (p ? [p.price] : [])), details.budget ?? 0, vendor.min_spend]);
      const bad = unknownAmounts(draft.reply, allowed);
      if (bad.length) {
        reasons.push(`The AI draft mentioned prices not on your list (${bad.map(fmtMoney).join(", ")}), so Matchire used the standard template instead.`);
      } else {
        body = draft.reply.trim();
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
    run("UPDATE messages SET status = 'discarded' WHERE enquiry_id = ? AND status = 'draft'", enquiryId);
    run(
      `UPDATE enquiries SET details = ?, quote = ?, lead = ?, event_date = ?, contact_name = COALESCE(contact_name, ?), owner_reason = ?,
       status = CASE WHEN ? = 'declines' THEN 'lost' ELSE status END, updated_at = ? WHERE id = ?`,
      JSON.stringify(details), quote ? JSON.stringify(quote) : null, lead, details.event_date, details.contact_name,
      needsOwner ? reasons.join(" ") || "Check this reply before it goes out." : null, details.intent, now, enquiryId,
    );
    if (details.intent === "declines") {
      run("UPDATE holds SET status = 'released' WHERE enquiry_id = ? AND status = 'active' AND kind = 'hold'", enquiryId);
      run("UPDATE enquiries SET next_followup_at = NULL WHERE id = ?", enquiryId);
    }
    return run("INSERT INTO messages (enquiry_id, direction, body, status, purpose, created_at) VALUES (?, 'out', ?, 'draft', ?, ?)", enquiryId, body, purpose, now);
  });

  let autoSent = false;
  if (vendor.auto_send && !needsOwner) {
    const r = await sendDraft(vendorId, draftId);
    autoSent = r.status === "sent";
  }
  return { enquiryId, draftId, autoSent, ownerReason: needsOwner ? reasons.join(" ") : null, usedAI };
}

// ---------- Sending ----------

export async function sendDraft(vendorId: number, messageId: number, opts: { body?: string; markBooked?: boolean } = {}) {
  const m = get<Message & { vendor_id: number }>(
    "SELECT m.*, e.vendor_id FROM messages m JOIN enquiries e ON e.id = m.enquiry_id WHERE m.id = ?",
    messageId,
  );
  if (!m || m.vendor_id !== vendorId) throw new Error("Message not found");
  if (m.status !== "draft") throw new Error("This reply was already handled");
  const vendor = getVendor(vendorId)!;
  const e = getEnquiry(vendorId, m.enquiry_id)!;
  const body = (opts.body ?? m.body).trim();
  const result = await deliver(vendor, e, body);
  const now = nowIso();

  if (result.status === "manual") {
    // Nothing went out. Keep the draft (with any edits) so the vendor can copy it and confirm.
    run("UPDATE messages SET body = ? WHERE id = ?", body, messageId);
    run("UPDATE enquiries SET owner_reason = ? WHERE id = ?", result.error ?? "Copy this reply and send it yourself.", e.id);
    return result;
  }
  tx(() => {
    run("UPDATE messages SET body = ?, status = ?, error = ?, sent_at = ? WHERE id = ?", body, result.status, result.error ?? null, result.status === "failed" ? null : now, messageId);
    if (result.status === "failed") return;
    run("UPDATE enquiries SET first_response_at = COALESCE(first_response_at, ?), last_outbound_at = ?, owner_reason = NULL, updated_at = ? WHERE id = ?", now, now, now, e.id);
    afterSend(vendor, e, m.purpose ?? "quote", now);
  });
  if (opts.markBooked && result.status === "sent") markBooked(vendorId, e.id);
  return result;
}

const hoursFrom = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * 3600_000).toISOString();

function afterSend(vendor: Vendor, e: Enquiry, purpose: string, now: string) {
  const d = parseDetails(e);
  const followup = hoursFrom(now, vendor.followup_days * 24);
  switch (purpose) {
    case "quote": {
      const exact = d.event_date && !d.date_is_approximate;
      const has = get<{ id: number }>("SELECT id FROM holds WHERE enquiry_id = ? AND status = 'active'", e.id);
      let nudge = followup;
      if (exact && !has && availability(vendor, d.event_date!, e.id).available) {
        run("INSERT INTO holds (vendor_id, enquiry_id, date, kind, note, expires_at) VALUES (?, ?, ?, 'hold', ?, ?)",
          vendor.id, e.id, d.event_date!, e.contact_name || d.contact_name || "Enquiry", hoursFrom(now, vendor.hold_hours));
        // Nudge while the date is still held, so the planner can still act on it.
        nudge = hoursFrom(now, Math.min(vendor.followup_days * 24, vendor.hold_hours / 2));
      }
      run("UPDATE enquiries SET status = 'quoted', followup_stage = 0, next_followup_at = ? WHERE id = ?", nudge, e.id);
      break;
    }
    case "ask_info":
      run("UPDATE enquiries SET status = 'awaiting_info', followup_stage = 0, next_followup_at = ? WHERE id = ?", followup, e.id);
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
  tx(() => {
    run("UPDATE messages SET body = ?, status = 'manual', error = NULL, sent_at = ? WHERE id = ?", (body ?? m.body).trim(), now, messageId);
    run("UPDATE enquiries SET first_response_at = COALESCE(first_response_at, ?), last_outbound_at = ?, owner_reason = NULL, updated_at = ? WHERE id = ?", now, now, now, e.id);
    afterSend(vendor, e, m.purpose ?? "quote", now);
  });
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
  if (ticking) return { expired: 0, followups: 0 };
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
      const body = templateDraft(vendor, {
        purpose, details: parseDetails(e), quote: parseQuote(e), available: null, missing: [], holdHours: null,
        partnerSuggestions: [], referredTo: null, depositNote: "",
      });
      const id = run("INSERT INTO messages (enquiry_id, direction, body, status, purpose) VALUES (?, 'out', ?, 'draft', ?)", e.id, body, purpose);
      followups++;
      if (vendor.auto_send) await sendDraft(vendor.id, id).catch(() => null);
      else run("UPDATE enquiries SET owner_reason = ? WHERE id = ?", purpose === "followup" ? "Follow-up ready: the planner hasn't replied." : "Last call before the hold expires.", e.id);
    }
    return { expired: expired.length, followups };
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
