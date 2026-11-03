import { all, get, run } from "./db.ts";

// Per-vendor rules about a contact (a WhatsApp number or an email address):
// - "hidden": the vendor never wants to see their messages (friends, suppliers).
//   Dropped before they're stored or read by the AI; only a count is kept.
// - "always": the vendor said this contact is a client, so their messages are
//   never filed under Other.

export type RuleKind = "hidden" | "always";

/** One key per contact: emails lower-cased, phone numbers as digits with Singapore's 65 added to 8-digit numbers. */
export function contactKey(value: string | null | undefined): string | null {
  const t = (value ?? "").trim().toLowerCase();
  if (!t) return null;
  if (t.includes("@")) return t;
  const digits = t.replace(/\D/g, "");
  if (digits.length >= 8) return digits.length === 8 ? `65${digits}` : digits;
  return t;
}

export interface ContactRule { id: number; vendor_id: number; contact_key: string; display: string; kind: RuleKind; hidden_count: number; created_at: string }

export const listRules = (vendorId: number, kind: RuleKind) =>
  all<ContactRule>("SELECT * FROM contact_rules WHERE vendor_id = ? AND kind = ? ORDER BY id DESC", vendorId, kind);

export function ruleFor(vendorId: number, ...contacts: (string | null | undefined)[]): ContactRule | null {
  for (const c of contacts) {
    const key = contactKey(c);
    if (!key) continue;
    const r = get<ContactRule>("SELECT * FROM contact_rules WHERE vendor_id = ? AND contact_key = ?", vendorId, key);
    if (r) return r;
  }
  return null;
}

/** Sets the rule for a contact (one rule per contact: hiding replaces "always", and the other way round). */
export function setRule(vendorId: number, contact: string, kind: RuleKind): ContactRule {
  const key = contactKey(contact);
  if (!key) throw new Error("No number or email address to remember.");
  run(
    `INSERT INTO contact_rules (vendor_id, contact_key, display, kind, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(vendor_id, contact_key) DO UPDATE SET kind = excluded.kind, display = excluded.display`,
    vendorId, key, contact.trim(), kind, new Date().toISOString(),
  );
  return get<ContactRule>("SELECT * FROM contact_rules WHERE vendor_id = ? AND contact_key = ?", vendorId, key)!;
}

export function removeRule(vendorId: number, ruleId: number) {
  run("DELETE FROM contact_rules WHERE id = ? AND vendor_id = ?", ruleId, vendorId);
}

/**
 * True if the vendor hid this contact: the message is dropped (not stored, not read by the AI) and only counted.
 * Call it before ingesting anything from WhatsApp or email.
 */
export function dropIfHidden(vendorId: number, ...contacts: (string | null | undefined)[]): boolean {
  const r = ruleFor(vendorId, ...contacts);
  if (!r || r.kind !== "hidden") return false;
  run("UPDATE contact_rules SET hidden_count = hidden_count + 1 WHERE id = ?", r.id);
  return true;
}

export const isAlwaysEnquiry = (vendorId: number, ...contacts: (string | null | undefined)[]) => ruleFor(vendorId, ...contacts)?.kind === "always";
