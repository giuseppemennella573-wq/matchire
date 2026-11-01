import { createHash, randomBytes } from "node:crypto";
import { all, get, run } from "./db.ts";
import { isAdmin } from "./early-access.ts";
import { TZ } from "./dates.ts";

// Support view: the only way Matchire staff can open a vendor's desk. It needs a
// reason, is read-only, ends after 30 minutes, and every session and page is
// logged for the vendor to see in Settings → Account. The cookie holds a random
// token; only its hash is stored.

export const SUPPORT_MINUTES = 30;
export const SUPPORT_COOKIE = "matchire_support";
export const READ_ONLY_MESSAGE = "Support view is read-only: nothing was changed. End the support view to work in your own account.";

export interface SupportAccess {
  id: number;
  vendor_id: number;
  admin_user_id: number;
  admin_email: string;
  admin_name: string;
  reason: string;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  ended_by: string | null;
}

type Admin = { id: number; email: string; name: string; vendor_id: number };

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const firstName = (name: string) => name.trim().split(/\s+/)[0] || "Matchire";

/** Sessions whose time ran out (the tab was closed, or nobody clicked End now) are closed at their expiry time. */
export function closeExpired(now = new Date()) {
  run("UPDATE support_access SET ended_at = expires_at, ended_by = 'timeout' WHERE ended_at IS NULL AND expires_at <= ?", now.toISOString());
}

export function startSupport(admin: Admin, vendorId: number, reason: string, now = new Date()): { token: string; access: SupportAccess } {
  if (!isAdmin(admin)) throw new Error("Only Matchire admins can open a support view.");
  const why = reason.replace(/\s+/g, " ").trim();
  if (why.length < 5) throw new Error("Say why you're opening this account, e.g. \"Helping set up WhatsApp, vendor asked by email\".");
  if (why.length > 300) throw new Error("Keep the reason under 300 characters.");
  const vendor = get<{ id: number }>("SELECT id FROM vendors WHERE id = ?", vendorId);
  if (!vendor) throw new Error("That account no longer exists.");
  if (vendorId === admin.vendor_id) throw new Error("That's your own account.");
  // One support view at a time per admin.
  run("UPDATE support_access SET ended_at = ?, ended_by = 'replaced' WHERE admin_user_id = ? AND ended_at IS NULL", now.toISOString(), admin.id);
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(now.getTime() + SUPPORT_MINUTES * 60_000).toISOString();
  const id = run(
    "INSERT INTO support_access (vendor_id, admin_user_id, admin_email, admin_name, reason, token_hash, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    vendorId, admin.id, admin.email, firstName(admin.name), why, hash(token), now.toISOString(), expires,
  );
  return { token, access: get<SupportAccess>("SELECT * FROM support_access WHERE id = ?", id)! };
}

/** The live support session for this cookie and this signed-in admin, or null. */
export function activeSupport(token: string | undefined, user: { id: number; email: string } | null, now = new Date()): SupportAccess | null {
  if (!token || !user || !isAdmin(user)) return null;
  closeExpired(now);
  const a = get<SupportAccess>("SELECT * FROM support_access WHERE token_hash = ?", hash(token));
  if (!a || a.ended_at || a.admin_user_id !== user.id || a.expires_at <= now.toISOString()) return null;
  return a;
}

export function endSupport(token: string | undefined, by: "admin" | "logout" = "admin", now = new Date()): SupportAccess | null {
  if (!token) return null;
  const a = get<SupportAccess>("SELECT * FROM support_access WHERE token_hash = ?", hash(token));
  if (!a) return null;
  run("UPDATE support_access SET ended_at = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL", now.toISOString(), by, a.id);
  return get<SupportAccess>("SELECT * FROM support_access WHERE id = ?", a.id)!;
}

/** Records a page the admin opened: the path only, never what was on it. The same page twice in a row within 10 seconds counts once. */
export function logSupportPage(accessId: number, path: string, now = new Date()) {
  const clean = path.split(/[?#]/)[0].slice(0, 200);
  if (!clean.startsWith("/app") || clean.startsWith("/app/admin")) return;
  const last = get<{ path: string; viewed_at: string }>("SELECT path, viewed_at FROM support_access_pages WHERE access_id = ? ORDER BY id DESC LIMIT 1", accessId);
  if (last && last.path === clean && now.getTime() - new Date(last.viewed_at).getTime() < 10_000) return;
  run("INSERT INTO support_access_pages (access_id, path, viewed_at) VALUES (?, ?, ?)", accessId, clean, now.toISOString());
}

/** The vendor's owner login, shown in place of the admin's while in support view. */
export const vendorOwner = (vendorId: number) =>
  get<{ id: number; vendor_id: number; email: string; name: string }>("SELECT id, vendor_id, email, name FROM users WHERE vendor_id = ? ORDER BY id LIMIT 1", vendorId);

/** "Inbox", "Price list"… for a logged path. */
export function pageLabel(path: string): string {
  if (path === "/app") return "Today";
  if (/^\/app\/inbox\/\d+/.test(path)) return `Enquiry #${path.split("/")[3]}`;
  const labels: Record<string, string> = { "/app/inbox": "Inbox", "/app/prices": "Price list", "/app/calendar": "Calendar", "/app/partners": "Partners", "/app/settings": "Settings" };
  return labels[path] ?? path.replace(/^\/app\//, "");
}

export interface SupportVisit {
  id: number;
  started_at: string;
  ended_at: string;
  open: boolean;
  admin_name: string;
  reason: string;
  minutes: number;
  pages: string[];
}

/** This vendor's support sessions, newest first, for Settings → Account. */
export function supportVisits(vendorId: number, now = new Date()): SupportVisit[] {
  closeExpired(now);
  return all<SupportAccess>("SELECT * FROM support_access WHERE vendor_id = ? ORDER BY id DESC", vendorId).map((a) => {
    const end = a.ended_at ?? now.toISOString();
    const pages = all<{ path: string }>("SELECT path FROM support_access_pages WHERE access_id = ? ORDER BY id", a.id).map((p) => pageLabel(p.path));
    return {
      id: a.id,
      started_at: a.started_at,
      ended_at: end,
      open: !a.ended_at,
      admin_name: a.admin_name,
      reason: a.reason,
      minutes: Math.max(1, Math.round((new Date(end).getTime() - new Date(a.started_at).getTime()) / 60_000)),
      pages: pages.filter((p, i) => pages.indexOf(p) === i),
    };
  });
}

/** "14:32" in Singapore time. */
export const sgClock = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
