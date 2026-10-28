import { all, get, run, nowIso, tx } from "./db.ts";
import { sendRawEmail } from "./channels.ts";
import { formatDateTime } from "./dates.ts";

// Early-access sign-ups from the marketing page: storage, the alert email to
// the team, and the reads behind the admin page.

export interface Signup {
  id: number;
  name: string | null;
  business: string | null;
  vendor_type: string | null;
  enquiries_per_week: string | null;
  email: string | null;
  whatsapp: string | null;
  created_at: string;
  notified_at: string | null;
  notify_error: string | null;
  contacted_at: string | null;
}

export const ALERT_TO = () => process.env.EARLY_ACCESS_NOTIFY_EMAIL || "giuseppe.mennella@matchire.ai";

export function addSignup(s: Omit<Signup, "id" | "created_at" | "notified_at" | "notify_error" | "contacted_at">): number {
  return run(
    "INSERT INTO early_access (name, business, vendor_type, enquiries_per_week, email, whatsapp) VALUES (?, ?, ?, ?, ?, ?)",
    s.name, s.business, s.vendor_type, s.enquiries_per_week, s.email, s.whatsapp,
  );
}

/** wa.me link for a Singapore number written any common way ("9123 4567", "+65 9123-4567"). */
export function whatsappLink(raw: string | null): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.length === 8 && /^[3689]/.test(d)) d = "65" + d;
  return d.length >= 8 ? `https://wa.me/${d}` : null;
}

export function alertText(s: Signup): { subject: string; text: string } {
  const wa = whatsappLink(s.whatsapp);
  const appUrl = (process.env.APP_URL || "").replace(/\/$/, "");
  return {
    subject: `Early access: ${s.business || s.name} (${s.vendor_type || "vendor"})`,
    text: [
      "New early-access request on matchire.ai",
      "",
      `Name:              ${s.name ?? ""}`,
      `Business:          ${s.business ?? ""}`,
      `What they do:      ${s.vendor_type ?? ""}`,
      `Enquiries / week:  ${s.enquiries_per_week ?? ""}`,
      `Email:             ${s.email ?? ""}`,
      `WhatsApp:          ${s.whatsapp ?? ""}${wa ? `  (${wa})` : ""}`,
      `Received:          ${formatDateTime(s.created_at)} SGT`,
      "",
      "The page promises a WhatsApp reply within two working days.",
      appUrl ? `All sign-ups: ${appUrl}/app/admin` : "",
    ].join("\n").trim(),
  };
}

/** Email the team about a sign-up and record the outcome on the row. */
export async function notifySignup(id: number): Promise<string | null> {
  const s = get<Signup>("SELECT * FROM early_access WHERE id = ?", id);
  if (!s) return "Sign-up not found";
  const { subject, text } = alertText(s);
  let error: string | null;
  try {
    error = await sendRawEmail({ to: ALERT_TO(), subject, text, replyTo: s.email });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (error) run("UPDATE early_access SET notify_error = ? WHERE id = ?", error, id);
  else run("UPDATE early_access SET notified_at = ?, notify_error = NULL WHERE id = ?", nowIso(), id);
  return error;
}

// ---------- App accounts ----------
// Vendors can also create an account straight from /signup. They aren't
// early-access rows, so they're listed (and alerted) separately.

export interface Account {
  id: number;
  email: string;
  name: string;
  business: string;
  kind: string;
  created_at: string;
  enquiries: number;
  live_items: number;
  admin_contacted_at: string | null;
}

export const listAccounts = () =>
  all<Account>(
    `SELECT u.id, u.email, u.name, v.name business, v.kind, u.created_at, u.admin_contacted_at,
            (SELECT COUNT(*) FROM enquiries e WHERE e.vendor_id = v.id) enquiries,
            (SELECT COUNT(*) FROM items i WHERE i.vendor_id = v.id AND i.active = 1) live_items
     FROM users u JOIN vendors v ON v.id = u.vendor_id ORDER BY u.id DESC`,
  );

/** Email the team that someone created an app account. Returns an error message on failure. */
export async function notifyNewAccount(userId: number): Promise<string | null> {
  const a = get<Account>(
    "SELECT u.id, u.email, u.name, v.name business, v.kind, u.created_at, u.admin_contacted_at, 0 enquiries, 0 live_items FROM users u JOIN vendors v ON v.id = u.vendor_id WHERE u.id = ?",
    userId,
  );
  if (!a) return "Account not found";
  const appUrl = (process.env.APP_URL || "").replace(/\/$/, "");
  try {
    return await sendRawEmail({
      to: ALERT_TO(),
      subject: `New account: ${a.business} (${a.kind})`,
      replyTo: a.email,
      text: [
        "Someone created a Matchire account at /signup.",
        "",
        `Name:      ${a.name}`,
        `Business:  ${a.business}`,
        `Type:      ${a.kind}`,
        `Email:     ${a.email}`,
        `Created:   ${formatDateTime(a.created_at)} SGT`,
        "",
        appUrl ? `All accounts: ${appUrl}/app/admin#accounts` : "",
      ].join("\n").trim(),
    });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** New accounts the admin hasn't followed up yet. Admins' own logins are never flagged. */
export const accountsWaiting = (accounts = listAccounts()) => accounts.filter((a) => !a.admin_contacted_at && !isAdmin(a));

export function setAccountContacted(userId: number, contacted: boolean) {
  run("UPDATE users SET admin_contacted_at = ? WHERE id = ?", contacted ? nowIso() : null, userId);
}

/**
 * Terminate an account: the business and everything in it (logins and sessions,
 * price list, enquiries and messages, calendar, partnerships and referrals).
 * Copies of enquiries it referred to partners stay in the partners' inboxes.
 * Admin logins can't be deleted here.
 */
export function deleteAccount(userId: number): { business: string } {
  const a = get<{ id: number; email: string; vendor_id: number; business: string }>(
    "SELECT u.id, u.email, u.vendor_id, v.name business FROM users u JOIN vendors v ON v.id = u.vendor_id WHERE u.id = ?",
    userId,
  );
  if (!a) throw new Error("Account not found");
  if (isAdmin(a)) throw new Error("Admin accounts can't be deleted from here.");
  tx(() => {
    run("UPDATE enquiries SET referred_from = NULL WHERE referred_from = ?", a.vendor_id);
    run("DELETE FROM vendors WHERE id = ?", a.vendor_id);
  });
  return { business: a.business };
}

export const listSignups = () => all<Signup>("SELECT * FROM early_access ORDER BY id DESC");
/** Everything waiting for the admin: early-access requests and new app accounts not yet marked contacted. */
export const countUncontacted = () =>
  (get<{ n: number }>("SELECT COUNT(*) n FROM early_access WHERE contacted_at IS NULL")?.n ?? 0) + accountsWaiting().length;

export function deleteSignup(id: number) {
  run("DELETE FROM early_access WHERE id = ?", id);
}

export function setContacted(id: number, contacted: boolean) {
  run("UPDATE early_access SET contacted_at = ? WHERE id = ?", contacted ? nowIso() : null, id);
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Quote everything, and neutralise leading =+-@ so spreadsheets don't run it as a formula.
  return `"${(/^[=+\-@]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`;
};

export function signupsCsv(rows: Signup[]): string {
  const cols: (keyof Signup)[] = ["created_at", "name", "business", "vendor_type", "enquiries_per_week", "email", "whatsapp", "contacted_at", "notified_at"];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
}

/**
 * Who can see the admin pages: the logins listed in ADMIN_EMAILS (comma-separated),
 * or, when that isn't set, the first account created on this deployment (the owner).
 */
export function isAdmin(user: { id: number; email: string }): boolean {
  const list = (process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (list.length) return list.includes(user.email.toLowerCase());
  const first = get<{ id: number }>("SELECT id FROM users ORDER BY id LIMIT 1");
  return first?.id === user.id;
}
