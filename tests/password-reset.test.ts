import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-pw-")), "test.db");
delete process.env.SMTP_HOST;
delete process.env.RESEND_API_KEY;

const { createAccount, createSession, login, userForSession } = await import("../src/lib/accounts.ts");
const R = await import("../src/lib/password-reset.ts");
const { get, all } = await import("../src/lib/db.ts");

let userId: number;
before(() => {
  userId = createAccount({ email: "ana@snap.sg", password: "old-password", name: "Ana", business: "Snapbox", kind: "photobooth" }).userId;
});

test("a reset link works once, ends every session, and only its hash is stored", () => {
  const s1 = createSession(userId).token;
  const raw = R.createResetToken(userId);
  assert.equal(R.resetTokenUser(raw)?.id, userId);
  assert.equal(get("SELECT 1 FROM password_resets WHERE token_hash = ?", raw), undefined, "raw token isn't stored");

  assert.deepEqual(R.resetPassword(raw, "short"), { ok: false, error: "Use a password of at least 8 characters." });
  assert.equal(R.resetPassword(raw, "new-password").ok, true);
  assert.equal(login("ana@snap.sg", "new-password"), userId);
  assert.equal(login("ana@snap.sg", "old-password"), null);
  assert.equal(userForSession(s1), null, "old sessions are logged out");
  assert.equal(R.resetPassword(raw, "another-one").ok, false, "a link can't be used twice");
});

test("links expire after an hour, and only the newest link works", () => {
  const t0 = new Date();
  const first = R.createResetToken(userId, t0);
  const second = R.createResetToken(userId, t0);
  assert.equal(R.resetTokenUser(first, t0), null);
  assert.equal(R.resetTokenUser(second, t0)?.id, userId);
  assert.equal(R.resetTokenUser(second, new Date(t0.getTime() + 61 * 60_000)), null);
});

test("asking for a link never reveals whether the email exists, and is rate limited", async () => {
  assert.equal(await R.requestPasswordReset("nobody@x.sg", "https://app.example"), "no_account");
  const now = new Date(Date.now() + 2 * 3600_000); // clear of the earlier tests' links
  // Email isn't configured in tests, so each attempt reports why it wasn't sent, but the link is still created.
  for (let i = 0; i < 3; i++) assert.match(await R.requestPasswordReset("ANA@snap.sg ", "https://app.example", now), /SMTP_HOST/);
  assert.equal(await R.requestPasswordReset("ana@snap.sg", "https://app.example", now), "rate_limited");
});

test("changing the password needs the current one and keeps only this session", () => {
  const keep = createSession(userId).token;
  const other = createSession(userId).token;
  assert.equal(R.changePassword(userId, "wrong", "brand-new-pw", keep), "Your current password isn't right.");
  assert.equal(R.changePassword(userId, "new-password", "brand-new-pw", keep), null);
  assert.ok(userForSession(keep));
  assert.equal(userForSession(other), null);
  assert.equal(login("ana@snap.sg", "brand-new-pw"), userId);
});

test("the emergency script sets a password the app accepts", () => {
  execFileSync(process.execPath, ["scripts/set-password.mjs", "ana@snap.sg", "from-the-shell"], { env: { ...process.env }, stdio: "pipe" });
  assert.equal(login("ana@snap.sg", "from-the-shell"), userId);
  assert.equal(all("SELECT 1 FROM sessions WHERE user_id = ?", userId).length, 0);
});
