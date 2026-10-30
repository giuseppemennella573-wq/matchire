import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { get, run, tx } from "./db.ts";
import type { Item, User, Vendor, VendorKind } from "./types.ts";
import { applyCardExtraHour, fmtMoney } from "./pricing.ts";

// Accounts, sessions and starter price lists. Kept free of Next.js imports so
// scripts and tests can use it directly.

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(pw, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

export const token = (bytes = 24) => randomBytes(bytes).toString("base64url");

function slugify(name: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "vendor";
  let slug = base;
  for (let i = 2; get("SELECT 1 FROM vendors WHERE slug = ?", slug); i++) slug = `${base}-${i}`;
  return slug;
}

type SampleItem = Omit<Item, "id" | "vendor_id" | "active" | "sort">;
const pkg = (name: string, pricing: Item["pricing"], price: number, o: Partial<SampleItem> = {}): SampleItem => ({
  kind: "package", name, description: "", pricing, price, included_hours: null, extra_hour_price: null, min_pax: null, max_pax: null, ...o,
});
const addon = (name: string, pricing: Item["pricing"], price: number, o: Partial<SampleItem> = {}): SampleItem => ({ ...pkg(name, pricing, price, o), kind: "addon" });

/** Starter price lists, mirroring the demo on the landing page. Vendors edit them after signing up. */
export const SAMPLE_PRICES: Partial<Record<VendorKind, { items: SampleItem[]; vendor?: Partial<Vendor> }>> = {
  photobooth: {
    items: [
      pkg("Classic booth", "flat", 450, { included_hours: 2, extra_hour_price: 120, description: "Unlimited 4R prints, props, attendant, digital gallery" }),
      pkg("360 booth", "flat", 650, { included_hours: 2, extra_hour_price: 180, description: "Slow-motion 360 video booth with instant sharing" }),
      addon("Custom print frame", "flat", 80, { description: "Custom frame or logo design" }),
      addon("Setup & transport", "flat", 60),
      addon("Guestbook album", "flat", 120),
    ],
    vendor: { offpeak_discount: 20, jobs_per_day: 2 },
  },
  venue: {
    items: [
      pkg("Venue hire", "per_hour", 280, { included_hours: 3, description: "Exclusive use, tables and chairs, projector and screen included" }),
      addon("Cleaning", "flat", 80),
      addon("Bar package", "per_pax", 25, { description: "Free-flow soft drinks and beer" }),
    ],
    vendor: { capacity: 60, offpeak_discount: 25, min_spend: 800 },
  },
  caterer: {
    items: [
      pkg("Buffet", "per_pax", 32, { min_pax: 30, description: "Local favourites, 8 dishes, halal-certified kitchen" }),
      pkg("Canapés", "per_pax", 28, { min_pax: 30, description: "6 pieces per guest" }),
      pkg("Bento sets", "per_pax", 16, { min_pax: 10, description: "Individually packed meals" }),
      addon("Delivery & setup", "flat", 60),
      addon("Service staff", "per_hour", 35),
    ],
    vendor: { jobs_per_day: 3 },
  },
  av: {
    items: [
      pkg("PA + 2 wireless mics", "flat", 280, { included_hours: 4, extra_hour_price: 50, description: "For up to 120 guests" }),
      pkg("LED wall 3×2m", "flat", 3200, { included_hours: 8 }),
      addon("Projector & screen", "flat", 220),
      addon("Technician on site", "flat", 180),
    ],
    vendor: { jobs_per_day: 2 },
  },
};

export function addItems(vendorId: number, items: SampleItem[], active = true) {
  items.forEach((i, n) =>
    run(
      `INSERT INTO items (vendor_id, kind, name, description, pricing, price, included_hours, extra_hour_price, min_pax, max_pax, active, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      vendorId, i.kind, i.name, i.description, i.pricing, i.price, i.included_hours, i.extra_hour_price, i.min_pax, i.max_pax, active ? 1 : 0, n,
    ),
  );
}

/**
 * Save an imported rate card for review (not live). One extra-hour rate for
 * the whole card goes on every package without its own. Returns the message
 * for the vendor.
 */
export function saveImportedRateCard(vendorId: number, card: { items: SampleItem[]; extra_hour_price_all?: number | null; notes: string }): string {
  const items = card.items.map((i) => ({ ...i, description: i.description ?? "" }));
  const applied = applyCardExtraHour(items, card.extra_hour_price_all);
  addItems(vendorId, items, false);
  if (card.notes.trim()) run("UPDATE vendors SET notes = TRIM(notes || char(10) || ?) WHERE id = ?", card.notes.trim(), vendorId);
  const rate = applied ? ` The card's extra-hour rate (${fmtMoney(card.extra_hour_price_all!)}) was applied to ${applied} package${applied > 1 ? "s" : ""}: check it on each.` : "";
  return `Imported ${items.length} items for review.${rate} Check each one, then make them live.`;
}

export function createAccount(input: { email: string; password: string; name: string; business: string; kind: VendorKind; samplePrices?: boolean }): { userId: number; vendorId: number } {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address.");
  if (input.password.length < 8) throw new Error("Use a password of at least 8 characters.");
  if (!input.business.trim()) throw new Error("Enter your business name.");
  if (get("SELECT 1 FROM users WHERE email = ?", email)) throw new Error("An account with this email already exists.");
  return tx(() => {
    const sample = SAMPLE_PRICES[input.kind];
    const v = sample?.vendor ?? {};
    const vendorId = run(
      `INSERT INTO vendors (name, kind, slug, signoff, capacity, jobs_per_day, min_spend, offpeak_discount, inbound_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.business.trim(), input.kind, slugify(input.business), `${input.name.trim().split(" ")[0]}, ${input.business.trim()}`,
      input.samplePrices ? v.capacity ?? null : null, v.jobs_per_day ?? 1, input.samplePrices ? v.min_spend ?? 0 : 0,
      input.samplePrices ? v.offpeak_discount ?? 0 : 0, token(12).toLowerCase().replace(/[^a-z0-9]/g, "x"),
    );
    const userId = run("INSERT INTO users (vendor_id, email, name, password_hash) VALUES (?, ?, ?, ?)", vendorId, email, input.name.trim(), hashPassword(input.password));
    if (input.samplePrices && sample) addItems(vendorId, sample.items);
    return { userId, vendorId };
  });
}

const SESSION_DAYS = 30;

export function createSession(userId: number): { token: string; expires: Date } {
  const t = token(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", t, userId, expires.toISOString());
  return { token: t, expires };
}

export function userForSession(t: string | undefined): (User & { vendor_id: number }) | null {
  if (!t) return null;
  const u = get<User>(
    "SELECT u.id, u.vendor_id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?",
    t, new Date().toISOString(),
  );
  return u ?? null;
}

export function deleteSession(t: string) {
  run("DELETE FROM sessions WHERE token = ?", t);
}

export function login(email: string, password: string): number | null {
  const u = get<{ id: number; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = ?", email.trim().toLowerCase());
  if (!u || !verifyPassword(password, u.password_hash)) return null;
  return u.id;
}
