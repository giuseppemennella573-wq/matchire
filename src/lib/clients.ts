import { all } from "./db.ts";
import type { Enquiry, Quote } from "./types.ts";

// Regular clients: the same planner coming back to the same vendor. The vendor
// sees their history; the draft is only told "returning client", never what
// they booked or paid, so nothing from an old conversation reaches a planner.

/** Channels whose sender we can trust: WhatsApp numbers come from Meta, email addresses from the inbound mail. */
const VERIFIED = new Set(["whatsapp", "email"]);

export interface ClientHistory {
  /** False when the current enquiry's name and number were typed into a form (or pasted), so anyone could claim them. */
  verified: boolean;
  channel: string;
  bookings: number;
  last: { id: number; label: string; date: string | null; booked: boolean };
  earlier: { id: number; status: string; created_at: string; event_date: string | null }[];
}

type Row = Pick<Enquiry, "id" | "channel" | "contact_handle" | "contact_email" | "status" | "event_date" | "created_at"> & { quote: string | null; replied: number };

const keysOf = (e: Pick<Enquiry, "contact_handle" | "contact_email">) => {
  const keys: string[] = [];
  for (const v of [e.contact_handle, e.contact_email]) {
    if (!v) continue;
    const t = v.trim().toLowerCase();
    if (t.includes("@")) keys.push(t);
    else {
      const digits = t.replace(/\D/g, "");
      if (digits.length >= 8) keys.push(digits.length === 8 ? `65${digits}` : digits); // "9123 4501" = "+65 9123 4501"
      else if (t) keys.push(t);
    }
  }
  return keys;
};

/** Earlier enquiries from the same client with this vendor that went somewhere (booked, quoted or answered), or null. */
export function clientHistory(e: Pick<Enquiry, "id" | "vendor_id" | "channel" | "contact_handle" | "contact_email">): ClientHistory | null {
  const mine = new Set(keysOf(e));
  if (!mine.size) return null;
  const rows = all<Row>(
    `SELECT e.id, e.channel, e.contact_handle, e.contact_email, e.status, e.event_date, e.created_at, e.quote,
            EXISTS (SELECT 1 FROM messages m WHERE m.enquiry_id = e.id AND m.direction = 'out' AND m.status IN ('sent', 'manual')) replied
     FROM enquiries e WHERE e.vendor_id = ? AND e.id <> ? AND e.created_at < (SELECT created_at FROM enquiries WHERE id = ?)
     ORDER BY e.created_at DESC`,
    e.vendor_id, e.id, e.id,
  ).filter((r) => keysOf(r).some((k) => mine.has(k)) && (r.status === "won" || r.status === "quoted" || r.status === "expired" || r.replied));
  if (!rows.length) return null;
  const won = rows.filter((r) => r.status === "won");
  const lastRow = won[0] ?? rows[0];
  const q: Quote | null = lastRow.quote ? JSON.parse(lastRow.quote) : null;
  return {
    verified: VERIFIED.has(e.channel),
    channel: e.channel,
    bookings: won.length,
    last: { id: lastRow.id, label: q?.lines[0]?.label ?? "", date: lastRow.event_date, booked: lastRow.status === "won" },
    earlier: rows.map((r) => ({ id: r.id, status: r.status, created_at: r.created_at, event_date: r.event_date })),
  };
}

const monthYear = (iso: string) => new Date(iso).toLocaleDateString("en-SG", { month: "short", year: "numeric", timeZone: "Asia/Singapore" });
const longDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "Booked with you 2× · last: Classic Booth 3h, 14 Mar 2026", or "Enquired before (Jun 2026)". */
export function clientNote(h: ClientHistory): string {
  const tail = h.verified ? "" : h.channel === "web" ? " (from the web form, unverified)" : " (unverified)";
  if (h.bookings) {
    const what = [h.last.label, h.last.date ? longDate(h.last.date) : null].filter(Boolean).join(", ");
    return `Booked with you ${h.bookings}×${what ? ` · last: ${what}` : ""}${tail}`;
  }
  return `Enquired before (${monthYear(h.earlier[0].created_at)})${tail}`;
}

/** What the draft may know: only that a verified contact is a returning client. */
export const returningForDraft = (h: ClientHistory | null) => !!h && h.verified;
