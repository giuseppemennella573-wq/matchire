import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-sup-")), "test.db");
delete process.env.ADMIN_EMAILS;

const { createAccount } = await import("../src/lib/accounts.ts");
const S = await import("../src/lib/support.ts");
const { get, all } = await import("../src/lib/db.ts");

type Acc = { userId: number; vendorId: number };
let admin: Acc, mel: Acc, other: Acc;
const user = (a: Acc) => get<{ id: number; email: string; name: string; vendor_id: number }>("SELECT id, email, name, vendor_id FROM users WHERE id = ?", a.userId)!;
const T0 = new Date("2026-11-01T06:00:00Z"); // 14:00 SGT
const later = (min: number) => new Date(T0.getTime() + min * 60_000);

before(() => {
  admin = createAccount({ email: "giuseppe@matchire.ai", password: "password1", name: "Giuseppe Mennella", business: "Matchire", kind: "other" }); // first account = admin
  mel = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth" });
  other = createAccount({ email: "ali@cater.sg", password: "password1", name: "Ali", business: "Ali Catering", kind: "caterer" });
});

test("a non-admin can't start a support view", () => {
  assert.throws(() => S.startSupport(user(mel), other.vendorId, "Just looking around", T0), /Only Matchire admins/);
  assert.equal(all("SELECT * FROM support_access").length, 0);
});

test("a reason is required", () => {
  for (const r of ["", "   ", "hi"]) assert.throws(() => S.startSupport(user(admin), mel.vendorId, r, T0), /Say why/);
  assert.throws(() => S.startSupport(user(admin), admin.vendorId, "Testing my own account", T0), /your own account/);
  assert.throws(() => S.startSupport(user(admin), 9999, "Helping with WhatsApp", T0), /no longer exists/);
});

test("a session is logged with admin, vendor, reason and times, and ends after 30 minutes", () => {
  const { token, access } = S.startSupport(user(admin), mel.vendorId, "  Helping set up WhatsApp,\n vendor asked by email ", T0);
  assert.equal(access.reason, "Helping set up WhatsApp, vendor asked by email");
  assert.equal(access.admin_name, "Giuseppe");
  assert.equal(access.admin_email, "giuseppe@matchire.ai");
  assert.equal(access.vendor_id, mel.vendorId);
  assert.equal(access.started_at, T0.toISOString());
  assert.equal(access.expires_at, later(30).toISOString());
  assert.equal(S.sgClock(access.expires_at), "14:30");
  assert.ok(!JSON.stringify(get("SELECT * FROM support_access WHERE id = ?", access.id)).includes(token), "only the token's hash is stored");

  assert.equal(S.activeSupport(token, user(admin), later(29))?.id, access.id);
  assert.equal(S.activeSupport(token, user(admin), later(30)), null, "over at 30 minutes");
  // The admin just closed the tab: the session still closes, at its expiry time.
  const row = get<{ ended_at: string; ended_by: string }>("SELECT ended_at, ended_by FROM support_access WHERE id = ?", access.id)!;
  assert.deepEqual({ ...row }, { ended_at: later(30).toISOString(), ended_by: "timeout" });
});

test("only the admin who started it can use the session; the vendor's own login is unaffected", () => {
  const { token } = S.startSupport(user(admin), mel.vendorId, "Checking the price list import", T0);
  assert.equal(S.activeSupport(token, user(mel), later(1)), null, "the vendor holding the cookie doesn't get support mode");
  assert.equal(S.activeSupport(token, user(other), later(1)), null);
  assert.equal(S.activeSupport(undefined, user(mel), later(1)), null);
  assert.equal(S.activeSupport("made-up-token", user(admin), later(1)), null);
  S.endSupport(token, "admin", later(2));
  assert.equal(S.activeSupport(token, user(admin), later(3)), null, "End now ends it");
});

test("starting a new session ends the admin's previous one", () => {
  const a = S.startSupport(user(admin), mel.vendorId, "First reason here", T0);
  const b = S.startSupport(user(admin), other.vendorId, "Second reason here", later(1));
  assert.equal(S.activeSupport(a.token, user(admin), later(2)), null);
  assert.equal(S.activeSupport(b.token, user(admin), later(2))?.vendor_id, other.vendorId);
  S.endSupport(b.token, "admin", later(3));
});

test("every page view is logged as a path only, without repeats or admin pages", () => {
  const { token, access } = S.startSupport(user(admin), other.vendorId, "Vendor asked why a quote was wrong", T0);
  S.logSupportPage(access.id, "/app", later(0));
  S.logSupportPage(access.id, "/app", new Date(later(0).getTime() + 2000)); // layout + page in one render
  S.logSupportPage(access.id, "/app/inbox/12?q=private+search", later(1));
  S.logSupportPage(access.id, "/app/prices", later(2));
  S.logSupportPage(access.id, "/app/admin/accounts", later(3));
  S.logSupportPage(access.id, "/somewhere-else", later(3));
  S.logSupportPage(access.id, "/app", later(4));
  assert.deepEqual(all<{ path: string }>("SELECT path FROM support_access_pages WHERE access_id = ? ORDER BY id", access.id).map((p) => p.path), ["/app", "/app/inbox/12", "/app/prices", "/app"]);
  S.endSupport(token, "admin", later(5));

  const [visit] = S.supportVisits(other.vendorId, later(10));
  assert.equal(visit.reason, "Vendor asked why a quote was wrong");
  assert.equal(visit.minutes, 5);
  assert.deepEqual(visit.pages, ["Today", "Enquiry #12", "Price list"]);
});

test("demo accounts can be opened, and are logged the same way", async () => {
  const { run } = await import("../src/lib/db.ts");
  run("UPDATE vendors SET is_demo = 1 WHERE id = ?", other.vendorId);
  const { access } = S.startSupport(user(admin), other.vendorId, "Showing the demo to a prospect", T0);
  assert.ok(get("SELECT 1 FROM support_access WHERE id = ?", access.id));
  run("UPDATE vendors SET is_demo = 0 WHERE id = ?", other.vendorId);
});

test("read-only: every vendor server action goes through requireVendorForAction, which refuses in support view", () => {
  const src = readFileSync(path.join(import.meta.dirname, "..", "src", "app", "app", "actions.ts"), "utf8");
  const actions = [...src.matchAll(/export async function (\w+)\([^)]*\) \{\n([^\n]*)/g)];
  assert.ok(actions.length >= 20);
  for (const [, name, first] of actions) assert.match(first, /await requireVendorForAction\(\)/, `${name} must use requireVendorForAction`);
  assert.ok(!/\brequireVendor\(\)/.test(src), "no action reads the vendor through the page-only helper");
  const auth = readFileSync(path.join(import.meta.dirname, "..", "src", "lib", "auth.ts"), "utf8");
  const gate = auth.slice(auth.indexOf("export async function requireVendorForAction"));
  assert.match(gate, /if \(await currentSupport\(user\)\) \{[\s\S]*?redirect\(`\$\{back\}\?readonly=1`\)/);
});

// ---------- Step 4: what the vendor sees, and the start email ----------

test("the access log shows only this vendor's sessions, with an empty state otherwise", async () => {
  const fresh = createAccount({ email: "new@vendor.sg", password: "password1", name: "Nia", business: "Nia Florals", kind: "decor" });
  assert.deepEqual(S.supportVisits(fresh.vendorId, later(60)), [], "empty: 'Nobody at Matchire has opened your account.'");
  const melVisits = S.supportVisits(mel.vendorId, later(60));
  assert.ok(melVisits.length > 0);
  const ids = new Set(all<{ id: number }>("SELECT id FROM support_access WHERE vendor_id = ?", mel.vendorId).map((r) => r.id));
  for (const v of melVisits) assert.ok(ids.has(v.id), "never another vendor's session");
  assert.ok(melVisits.every((v) => v.admin_name === "Giuseppe" && v.reason && !v.open));
  // Settings shows the empty-state text and the promise underneath.
  const page = readFileSync(path.join(import.meta.dirname, "..", "src", "app", "app", "settings", "page.tsx"), "utf8");
  assert.ok(page.includes("Nobody at Matchire has opened your account."));
  assert.ok(page.includes("We only open your account when you ask us to. Every visit is listed here."));
});

test("the start email goes to the vendor's login email, and never from a demo account", async () => {
  const sent: { to: string; subject: string; text: string }[] = [];
  const send = async (m: { to: string; subject: string; text: string }) => { sent.push(m); return null; };
  const { access } = S.startSupport(user(admin), mel.vendorId, "Helping set up WhatsApp, vendor asked by email", T0);
  assert.equal(await S.notifySupportStart(access, send), "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "mel@snap.sg");
  assert.ok(sent[0].text.includes("Matchire support opened your account to: Helping set up WhatsApp, vendor asked by email. You can see this in Settings → Account."));

  const { run } = await import("../src/lib/db.ts");
  run("UPDATE vendors SET is_demo = 1 WHERE id = ?", other.vendorId);
  const demo = S.startSupport(user(admin), other.vendorId, "Showing the demo to a prospect", T0);
  assert.equal(await S.notifySupportStart(demo.access, send), "demo");
  assert.equal(sent.length, 1, "nothing sent for the demo account");
  run("UPDATE vendors SET is_demo = 0 WHERE id = ?", other.vendorId);
});
