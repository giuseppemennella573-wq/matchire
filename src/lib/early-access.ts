import { all, get, run, nowIso } from "./db.ts";
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

export const listSignups = () => all<Signup>("SELECT * FROM early_access ORDER BY id DESC");
export const countUncontacted = () => get<{ n: number }>("SELECT COUNT(*) n FROM early_access WHERE contacted_at IS NULL")?.n ?? 0;

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
