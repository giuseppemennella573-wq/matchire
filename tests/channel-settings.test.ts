import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-ch-")), "test.db");
delete process.env.ADMIN_EMAILS;
delete process.env.SMTP_HOST;
delete process.env.INBOUND_EMAIL_DOMAIN;
process.env.RESEND_API_KEY = "test";

const { createAccount, createSession } = await import("../src/lib/accounts.ts");
const C = await import("../src/lib/channel-settings.ts");
const E = await import("../src/lib/engine.ts");
const { run, all, get } = await import("../src/lib/db.ts");

const TOKEN = "EAAGsecretTokenValue1234XYZ9";
const PHONE_ID = "1303155252891862";
const calls: string[] = [];
globalThis.fetch = (async (url: string | URL) => {
  calls.push(String(url));
  if (String(url).includes("graph.facebook.com")) return Response.json({ display_phone_number: "+65 9647 2283" });
  return new Response("{}", { status: 200 }); // Resend
}) as typeof fetch;

let admin: { userId: number; vendorId: number }, vendor: { userId: number; vendorId: number };
before(() => {
  admin = createAccount({ email: "giuseppe@matchire.ai", password: "password1", name: "Giuseppe", business: "Matchire", kind: "other" }); // first account = admin
  vendor = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth" });
  run("UPDATE vendors SET wa_phone_number_id = ?, wa_token = ? WHERE id = ?", PHONE_ID, TOKEN, vendor.vendorId);
});

test("vendors never receive tokens, IDs or webhook URLs; admins get the token masked", () => {
  const v = E.getVendor(vendor.vendorId)!;
  const mine = C.channelView(v, { admin: false, appUrl: "https://app.example" });
  const page = JSON.stringify(mine);
  for (const secret of [TOKEN, TOKEN.slice(-4), PHONE_ID, v.inbound_token, "api/webhooks"]) assert.ok(!page.includes(secret), `vendor view leaks ${secret}`);
  assert.equal(mine.technical, undefined);
  assert.equal(mine.whatsapp.connected, true);

  const adminView = C.channelView(v, { admin: true, appUrl: "https://app.example" });
  assert.equal(adminView.technical!.phoneNumberId, PHONE_ID, "phone number ID in full for admins");
  assert.equal(adminView.technical!.tokenMasked, "••••XYZ9");
  assert.ok(!JSON.stringify(adminView).includes(TOKEN), "admins never get the full token either");
});

test("only admins can change channels; changes are logged without token values", async () => {
  await assert.rejects(C.updateChannels(vendor.vendorId, { token: "x" }, { id: vendor.userId, email: "mel@snap.sg", admin: false }), /Only Matchire admins/);

  const actor = { id: admin.userId, email: "giuseppe@matchire.ai", admin: true };
  assert.deepEqual(await C.updateChannels(vendor.vendorId, { phoneNumberId: PHONE_ID, token: undefined }, actor), [], "blank token keeps the saved one");
  const changed = await C.updateChannels(vendor.vendorId, { phoneNumberId: PHONE_ID, token: "EAAGbrandNewToken5678" }, actor);
  assert.deepEqual(changed, ["WhatsApp access token"]);
  const v = E.getVendor(vendor.vendorId)!;
  assert.equal(v.wa_token, "EAAGbrandNewToken5678");
  assert.equal(v.wa_display_number, "+65 9647 2283", "the number is looked up when the connection changes");
  const log = all<Record<string, unknown>>("SELECT * FROM channel_audit WHERE vendor_id = ?", vendor.vendorId);
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_email, "giuseppe@matchire.ai");
  assert.ok(!JSON.stringify(log).includes("EAAG"), "token values are never logged");

  await C.updateChannels(vendor.vendorId, { disconnect: true, templatesApproved: true, rotateInbound: true }, actor);
  assert.equal(E.getVendor(vendor.vendorId)!.wa_token, null);
  assert.deepEqual(C.channelAudit(vendor.vendorId).map((l) => l.field).slice(0, 4).sort(),
    ["Email forwarding address", "Follow-up templates approved", "WhatsApp access token (removed)", "WhatsApp phone number ID"]);
});

test("the vendor settings save no longer writes channel fields", () => {
  const src = readFileSync("src/app/app/actions.ts", "utf8");
  const save = src.slice(src.indexOf("export async function saveSettingsTabAction"));
  const update = save.slice(0, save.indexOf("revalidatePath"));
  assert.ok(!/UPDATE vendors SET[^`]*wa_(phone_number_id|token|templates_approved)/.test(update), "channel columns are only written by updateChannels");
  assert.match(update, /if \(isAdmin\(user\)\) \{[\s\S]*updateChannels\(/);
});

test("Request setup emails the admin once a day; the demo only simulates it", async () => {
  const v = E.getVendor(vendor.vendorId)!;
  const user = { name: "Mel", email: "mel@snap.sg" };
  const before = calls.filter((c) => c.includes("resend")).length;
  assert.equal(await C.requestChannelSetup(v, user, "whatsapp", "https://app.example"), "sent");
  assert.equal(calls.filter((c) => c.includes("resend")).length, before + 1);
  assert.equal(await C.requestChannelSetup(v, user, "whatsapp", "https://app.example"), "already_requested");
  assert.equal(await C.requestChannelSetup(v, user, "email", "https://app.example"), "sent", "each channel separately");

  run("UPDATE vendors SET is_demo = 1 WHERE id = ?", admin.vendorId);
  const n = calls.length;
  assert.equal(await C.requestChannelSetup(E.getVendor(admin.vendorId)!, user, "whatsapp", "https://app.example"), "demo");
  assert.equal(calls.length, n, "nothing sent for the demo");
  run("UPDATE vendors SET is_demo = 0 WHERE id = ?", admin.vendorId);
});

test("email status: waiting until an email enquiry arrives, then receiving", () => {
  process.env.INBOUND_EMAIL_DOMAIN = "in.example";
  let v = E.getVendor(vendor.vendorId)!;
  assert.equal(C.channelView(v, { admin: false, appUrl: "x" }).email.receiving, false);
  E.ingest({ vendorId: v.id, channel: "email", text: "Hi, booth for 12 Dec?", handle: "a@b.sg", email: "a@b.sg" });
  v = E.getVendor(vendor.vendorId)!;
  const view = C.channelView(v, { admin: false, appUrl: "x" });
  assert.equal(view.email.receiving, true);
  assert.equal(view.email.address, `${v.inbound_token}@in.example`);
  delete process.env.INBOUND_EMAIL_DOMAIN;
});

test("non-admins are refused by every admin page, route and action", () => {
  const adminSession = createSession(admin.userId).token;
  const vendorSession = createSession(vendor.userId).token;
  assert.equal(C.adminForSession(adminSession)?.id, admin.userId);
  assert.equal(C.adminForSession(vendorSession), null, "a vendor is not an admin");
  assert.equal(C.adminForSession(undefined), null);
  assert.equal(C.adminForSession("made-up"), null);

  // Every admin page and route (Early access, Accounts, Channels, Backups, CSV export, backup download)
  // must check the session through requireAdmin()/currentAdmin() before doing anything.
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk("src/app/app/admin");
  const entry = files.filter((f) => /(page\.tsx|route\.ts)$/.test(f));
  for (const f of ["page.tsx", "accounts/page.tsx", "channels/[vendorId]/page.tsx", "backups/page.tsx", "csv/route.ts", "backups/[file]/route.ts"]) {
    assert.ok(entry.includes(path.join("src/app/app/admin", f)), `${f} exists`);
  }
  for (const f of entry) {
    const src = readFileSync(f, "utf8");
    const body = src.slice(src.search(/export (default )?async function/));
    const firstAwait = body.match(/await (\w+)\(/)?.[1];
    assert.ok(firstAwait === "requireAdmin" || firstAwait === "currentAdmin", `${f} checks for an admin first (found ${firstAwait})`);
  }
  // Every server action in admin/actions.ts, including saving a vendor's channels.
  const actions = readFileSync("src/app/app/admin/actions.ts", "utf8").split(/(?=export async function )/).slice(1);
  assert.ok(actions.some((a) => a.startsWith("export async function saveVendorChannelsAction")));
  for (const a of actions) assert.match(a, /^export async function \w+\([^)]*\) \{\n\s+(const \{ user \} = )?await requireAdmin\(\);/, a.split("\n")[0]);
});
