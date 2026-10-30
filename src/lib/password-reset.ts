import { createHash, randomBytes } from "node:crypto";
import { get, run, tx } from "./db.ts";
import { hashPassword, verifyPassword } from "./accounts.ts";
import { sendRawEmail } from "./channels.ts";

// Password recovery. A reset link carries a one-time token that expires after
// an hour; only its SHA-256 is stored, so a copy of the database can't be used
// to reset anyone's password. Setting a new password ends every session.

const TTL_MS = 60 * 60_000;
const MAX_PER_HOUR = 3;
export const MIN_PASSWORD = 8;

const digest = (t: string) => createHash("sha256").update(t).digest("hex");

/** Create a reset token for a user and return the raw token (only ever sent by email). */
export function createResetToken(userId: number, now = new Date()): string {
  const raw = randomBytes(32).toString("base64url");
  tx(() => {
    // Only the newest link works.
    run("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL", now.toISOString(), userId);
    run("INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", digest(raw), userId, new Date(now.getTime() + TTL_MS).toISOString(), now.toISOString());
  });
  return raw;
}

/** The user a still-valid reset token belongs to, or null. */
export function resetTokenUser(raw: string, now = new Date()): { id: number; email: string } | null {
  if (!raw) return null;
  return get<{ id: number; email: string }>(
    `SELECT u.id, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
     WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?`,
    digest(raw), now.toISOString(),
  ) ?? null;
}

function resetEmail(link: string) {
  return {
    subject: "Reset your Matchire password",
    text: [
      "Someone asked to reset the password for your Matchire account.",
      "",
      "Choose a new password here (the link works once and expires in 1 hour):",
      link,
      "",
      "If this wasn't you, ignore this email. Your password stays the same.",
    ].join("\n"),
  };
}

/**
 * Email a reset link for this address, if it has an account. Callers show the
 * same message either way, so the form never reveals who has an account.
 * Returns why nothing was sent, for logs and tests.
 */
export async function requestPasswordReset(email: string, baseUrl: string, now = new Date()): Promise<"sent" | "no_account" | "rate_limited" | "demo" | string> {
  const u = get<{ id: number; email: string; is_demo: number }>("SELECT u.id, u.email, v.is_demo FROM users u JOIN vendors v ON v.id = u.vendor_id WHERE u.email = ?", email.trim().toLowerCase());
  if (!u) return "no_account";
  if (u.is_demo) return "demo"; // demo logins use DEMO_PASSWORD; never email them
  const recent = get<{ n: number }>("SELECT COUNT(*) n FROM password_resets WHERE user_id = ? AND created_at > ?", u.id, new Date(now.getTime() - TTL_MS).toISOString())!.n;
  if (recent >= MAX_PER_HOUR) return "rate_limited";
  const raw = createResetToken(u.id, now);
  const { subject, text } = resetEmail(`${baseUrl.replace(/\/$/, "")}/reset/${raw}`);
  const error = await sendRawEmail({ to: u.email, subject, text }).catch((e) => (e instanceof Error ? e.message : String(e)));
  return error ?? "sent";
}

/** Set a new password with a reset token. Ends every session for the account. */
export function resetPassword(raw: string, password: string, now = new Date()): { ok: true; userId: number } | { ok: false; error: string } {
  if (password.length < MIN_PASSWORD) return { ok: false, error: `Use a password of at least ${MIN_PASSWORD} characters.` };
  const u = resetTokenUser(raw, now);
  if (!u) return { ok: false, error: "This reset link has expired or was already used. Ask for a new one." };
  tx(() => {
    run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), u.id);
    run("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL", now.toISOString(), u.id);
    run("DELETE FROM sessions WHERE user_id = ?", u.id);
  });
  return { ok: true, userId: u.id };
}

/** Change the password of a signed-in user. Other sessions are ended; `keepSession` stays signed in. */
export function changePassword(userId: number, current: string, next: string, keepSession?: string): string | null {
  const u = get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", userId);
  if (!u || !verifyPassword(current, u.password_hash)) return "Your current password isn't right.";
  if (next.length < MIN_PASSWORD) return `Use a new password of at least ${MIN_PASSWORD} characters.`;
  tx(() => {
    run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(next), userId);
    run("DELETE FROM sessions WHERE user_id = ? AND token IS NOT ?", userId, keepSession ?? null);
  });
  return null;
}
