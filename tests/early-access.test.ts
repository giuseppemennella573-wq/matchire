import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-ea-")), "test.db");
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;
delete process.env.ADMIN_EMAILS;

const EA = await import("../src/lib/early-access.ts");
const { createAccount } = await import("../src/lib/accounts.ts");
const { get } = await import("../src/lib/db.ts");

test("sign-up is saved and the alert failure is recorded, not lost", async () => {
  const id = EA.addSignup({ name: "Ana", business: "Snapbox", vendor_type: "Photobooth", enquiries_per_week: "10–30", email: "ana@snap.sg", whatsapp: "9123 4567" });
  const err = await EA.notifySignup(id);
  assert.match(err!, /SMTP_HOST/);
  const row = get<{ notify_error: string | null; notified_at: string | null }>("SELECT * FROM early_access WHERE id = ?", id)!;
  assert.equal(row.notified_at, null);
  assert.ok(row.notify_error);
  assert.equal(EA.countUncontacted(), 1);
  EA.setContacted(id, true);
  assert.equal(EA.countUncontacted(), 0);
});

test("alert email goes to the configured address with the prospect's details", () => {
  assert.equal(EA.ALERT_TO(), "giuseppe.mennella@matchire.ai");
  const { subject, text } = EA.alertText({ id: 1, name: "Ana", business: "Snapbox", vendor_type: "Photobooth", enquiries_per_week: "10–30", email: "ana@snap.sg", whatsapp: "9123 4567", created_at: new Date().toISOString(), notified_at: null, notify_error: null, contacted_at: null });
  assert.equal(subject, "Early access: Snapbox (Photobooth)");
  assert.match(text, /ana@snap\.sg/);
  assert.match(text, /wa\.me\/6591234567/);
});

test("whatsapp links and CSV escaping", () => {
  assert.equal(EA.whatsappLink("+65 9123-4567"), "https://wa.me/6591234567");
  assert.equal(EA.whatsappLink("abc"), null);
  const csv = EA.signupsCsv([{ id: 1, name: '=HYPERLINK("x")', business: 'A "B"', vendor_type: null, enquiries_per_week: null, email: null, whatsapp: null, created_at: "t", notified_at: null, notify_error: null, contacted_at: null }]);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"A ""B"""/);
});

test("the first account is admin unless ADMIN_EMAILS is set", () => {
  const owner = createAccount({ email: "owner@m.sg", password: "password1", name: "O", business: "Owner Co", kind: "other" });
  const other = createAccount({ email: "vendor@m.sg", password: "password1", name: "V", business: "Vendor Co", kind: "other" });
  assert.equal(EA.isAdmin({ id: owner.userId, email: "owner@m.sg" }), true);
  assert.equal(EA.isAdmin({ id: other.userId, email: "vendor@m.sg" }), false);
  process.env.ADMIN_EMAILS = "Vendor@m.sg";
  assert.equal(EA.isAdmin({ id: other.userId, email: "vendor@m.sg" }), true);
  assert.equal(EA.isAdmin({ id: owner.userId, email: "owner@m.sg" }), false);
  delete process.env.ADMIN_EMAILS;
});

test("sign-ups can be deleted", () => {
  const id = EA.addSignup({ name: "Del", business: null, vendor_type: null, enquiries_per_week: null, email: "d@d.sg", whatsapp: null });
  EA.deleteSignup(id);
  assert.equal(get("SELECT 1 FROM early_access WHERE id = ?", id), undefined);
});

test("app accounts are listed for admins, and the new-account alert is attempted", async () => {
  const { userId } = createAccount({ email: "yes-mummy@hotmail.com", password: "password1", name: "Mum", business: "Yes Mummy", kind: "caterer" });
  const row = EA.listAccounts().find((a) => a.id === userId)!;
  assert.equal(row.email, "yes-mummy@hotmail.com");
  assert.equal(row.business, "Yes Mummy");
  assert.equal(row.enquiries, 0);
  // Email isn't configured in tests, so the alert reports why it wasn't sent.
  assert.match((await EA.notifyNewAccount(userId))!, /SMTP_HOST/);
});

test("new app accounts are flagged for the admin until marked contacted", () => {
  const before = EA.countUncontacted();
  const { userId } = createAccount({ email: "new@vendor.sg", password: "password1", name: "N", business: "New Co", kind: "other" });
  assert.equal(EA.countUncontacted(), before + 1);
  assert.ok(EA.accountsWaiting().some((a) => a.id === userId));
  EA.setAccountContacted(userId, true);
  assert.equal(EA.countUncontacted(), before);
  // The admin's own login is never flagged.
  const admin = EA.listAccounts().find((a) => EA.isAdmin(a))!;
  assert.ok(!EA.accountsWaiting().some((a) => a.id === admin.id));
});
