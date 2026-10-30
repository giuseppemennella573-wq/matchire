import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-demo-")), "test.db");
delete process.env.ANTHROPIC_API_KEY;
process.env.RESEND_API_KEY = "test"; // email is "configured", so only the demo guard can stop a send

const D = await import("../src/lib/demo.ts");
const E = await import("../src/lib/engine.ts");
const { createAccount, login } = await import("../src/lib/accounts.ts");
const { deliver, deliverTemplate } = await import("../src/lib/channels.ts");
const { requestPasswordReset } = await import("../src/lib/password-reset.ts");
const { get, all, run } = await import("../src/lib/db.ts");
const { dayOfWeek, sgToday, addDays } = await import("../src/lib/dates.ts");

// Any attempt to reach WhatsApp or an email API is recorded here.
const network: string[] = [];
globalThis.fetch = (async (url: string | URL) => { network.push(String(url)); return new Response("{}", { status: 200 }); }) as typeof fetch;

const counts = () => ({
  demoVendors: get<{ n: number }>("SELECT COUNT(*) n FROM vendors WHERE is_demo = 1")!.n,
  demoUsers: get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE email IN (?, ?, ?)", ...D.DEMO_EMAILS)!.n,
  items: get<{ n: number }>("SELECT COUNT(*) n FROM items i JOIN vendors v ON v.id = i.vendor_id WHERE v.is_demo = 1")!.n,
  holds: get<{ n: number }>("SELECT COUNT(*) n FROM holds h JOIN vendors v ON v.id = h.vendor_id WHERE v.is_demo = 1")!.n,
  enquiries: get<{ n: number }>("SELECT COUNT(*) n FROM enquiries e JOIN vendors v ON v.id = e.vendor_id WHERE v.is_demo = 1")!.n,
  drafts: get<{ n: number }>("SELECT COUNT(*) n FROM messages m JOIN enquiries e ON e.id = m.enquiry_id JOIN vendors v ON v.id = e.vendor_id WHERE v.is_demo = 1 AND m.status = 'draft'")!.n,
  partnerships: get<{ n: number }>("SELECT COUNT(*) n FROM partnerships")!.n,
});

test("seeding needs DEMO_PASSWORD", async () => {
  await assert.rejects(D.seedDemo(undefined), /Set DEMO_PASSWORD/);
  await assert.rejects(D.seedDemo("short"), /at least 8 characters/);
});

test("the seed never deletes a real account that uses the demo email", async () => {
  const real = createAccount({ email: D.DEMO_EMAIL, password: "real-password", name: "R", business: "Real Co", kind: "other" });
  await assert.rejects(D.seedDemo("demo-password"), /real \(non-demo\) account/);
  assert.ok(get("SELECT 1 FROM vendors WHERE id = ?", real.vendorId), "the real account is untouched");
  run("DELETE FROM vendors WHERE id = ?", real.vendorId);
});

test("seed:demo is idempotent and builds the Snap & Smile workspace", async () => {
  const first = await D.seedDemo("demo-password");
  const c1 = counts();
  const second = await D.seedDemo("demo-password");
  assert.deepEqual(counts(), c1, "running it twice gives the same result");
  assert.deepEqual(c1, { demoVendors: 3, demoUsers: 3, items: 10, holds: 2, enquiries: 3, drafts: 3, partnerships: 2 });
  assert.equal(second.bookedSaturday, first.bookedSaturday);

  const v = E.getVendor(second.vendorId)!;
  assert.equal(v.name, "Snap & Smile Photobooth");
  assert.equal(v.kind, "photobooth");
  assert.deepEqual([v.is_demo, v.auto_send, v.hold_hours, v.followup_days, v.jobs_per_day, v.bundle_suggestions, v.share_from_price, v.min_spend, v.offpeak_discount, v.referral_fee_pct], [1, 0, 48, 2, 2, 1, 0, 650, 10, 10]);
  assert.equal(v.signoff, "Mel @ Snap & Smile");
  assert.match(v.notes, /Sentosa or Jurong Island: \+S\$80/);
  assert.equal(login(D.DEMO_EMAIL, "demo-password"), get<{ id: number }>("SELECT id FROM users WHERE email = ?", D.DEMO_EMAIL)!.id);
  assert.ok(E.acceptedPartners(v.id).some((p) => p.name === "Rempah Kitchen" && p.is_demo));
  const snapbox = E.acceptedPartners(v.id).find((p) => p.name === "Snapbox SG")!;
  assert.deepEqual([snapbox.kind, snapbox.is_demo, snapbox.share_from_price], ["photobooth", 1, 1]);
  assert.deepEqual(E.sharedFromPrice(snapbox), { price: 450, unit: "" });
  assert.deepEqual(E.getItems(v.id).filter((i) => i.kind === "package").map((i) => [i.name, i.extra_hour_price]),
    [["Classic Booth 2h", 180], ["Classic Booth 3h", 180], ["Classic Booth 4h", 180], ["360 Video Booth 3h", 350]]);

  // The booked Saturday is 3+ weeks out and full; the clashing D&D is drafted as unavailable.
  const booked = second.bookedSaturday;
  assert.equal(dayOfWeek(booked), 6);
  assert.ok(booked >= addDays(sgToday(), 21) && booked < addDays(sgToday(), 28));
  assert.equal(E.availability(v, booked).available, false);
  const drafts = all<{ channel: string; purpose: string }>(
    "SELECT e.channel, m.purpose FROM messages m JOIN enquiries e ON e.id = m.enquiry_id WHERE e.vendor_id = ? AND m.status = 'draft' ORDER BY e.id", v.id,
  );
  assert.deepEqual(drafts.map((d) => d.channel), ["whatsapp", "instagram", "email"]);
  assert.equal(drafts[2].purpose, "unavailable");
  assert.equal(network.length, 0, "seeding sent nothing");

  // The three drafts, as a prospect sees them.
  const body = (channel: string) => get<{ body: string }>("SELECT m.body FROM messages m JOIN enquiries e ON e.id = m.enquiry_id WHERE e.vendor_id = ? AND e.channel = ? AND m.status = 'draft'", v.id, channel)!.body;
  const enquiry = (channel: string) => get<{ quote: string | null; status: string }>("SELECT quote, status FROM enquiries WHERE vendor_id = ? AND channel = ?", v.id, channel)!;
  // Sarah's wedding: quoted, with the bigger package's full total, the deposit and the hold deadline.
  assert.match(body("whatsapp"), /Total: SGD 1,000/);
  assert.match(body("whatsapp"), /Classic Booth 4h with the guestbook album is SGD 1,200/);
  assert.match(body("whatsapp"), /A deposit of SGD 300 \(30%\)/);
  assert.match(body("whatsapp"), /I'm holding the date for you until /);
  // Kelly on Instagram, "how much": qualifying questions, no price.
  assert.equal(drafts[1].purpose, "qualify");
  assert.match(body("instagram"), /Happy to send exact pricing! What's the date and roughly how many guests\?/);
  assert.doesNotMatch(body("instagram"), /SGD|\$/);
  assert.equal(enquiry("instagram").quote, null);
  // Bluewave's D&D on the booked Saturday: other dates, Snapbox SG with its shared price, not quoted.
  assert.match(body("email"), /I'm free on .+, would (either|that) work\?/);
  assert.match(body("email"), /our trusted partner Snapbox SG \(photobooth, from SGD 450\) may be free that evening/);
  assert.doesNotMatch(body("email").replace("from SGD 450", ""), /SGD|\$/, "no price for the booked date");
  assert.equal(enquiry("email").quote, null, "Not quoted, so the booking value stays empty");
});

test("demo accounts never reach WhatsApp or email, even with auto-send forced on", async () => {
  const v = E.getVendor(get<{ vendor_id: number }>("SELECT vendor_id FROM users WHERE email = ?", D.DEMO_EMAIL)!.vendor_id)!;
  run("UPDATE vendors SET wa_phone_number_id = 'PN', wa_token = 'T', auto_send = 1 WHERE id = ?", v.id);
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    const wa = E.getEnquiry(v.id, get<{ id: number }>("SELECT id FROM enquiries WHERE vendor_id = ? AND channel = 'whatsapp'", v.id)!.id)!;
    const mail = E.getEnquiry(v.id, get<{ id: number }>("SELECT id FROM enquiries WHERE vendor_id = ? AND channel = 'email'", v.id)!.id)!;
    const demo = E.getVendor(v.id)!;
    assert.deepEqual(await deliver(demo, wa, "hi"), { status: "sent", via: "demo" });
    assert.deepEqual(await deliver(demo, mail, "hi"), { status: "sent", via: "demo" });
    assert.deepEqual(await deliverTemplate(demo, wa, { name: "quote_nudge", params: ["Sarah", "Sat"] }), { status: "sent", via: "demo" });
    // The normal pipeline with auto-send on: the reply is "sent" (simulated) and the flow carries on.
    E.appendInbound(v.id, wa.id, "Great, please hold the date!");
    const r = await E.processEnquiry(v.id, wa.id);
    // Routine replies go out on their own (simulated); one that waits for the owner is sent by hand.
    if (!r.autoSent) await E.sendDraft(v.id, E.pendingDraft(wa.id)!.id);
    const out = all<{ status: string }>("SELECT status FROM messages WHERE enquiry_id = ? AND direction = 'out' AND status = 'sent'", wa.id);
    assert.ok(out.length >= 1, "the reply is recorded as sent in the demo");
  } finally {
    console.log = log;
  }
  assert.equal(network.length, 0, "no request left the server");
  assert.ok(logs.filter((l) => l.includes("demo: not sent")).length >= 4);
  assert.equal(await requestPasswordReset(D.DEMO_EMAIL, "https://app.example"), "demo", "no reset email for demo logins");
  assert.equal(network.length, 0);
});

test("demo and real accounts can't be partners", () => {
  assert.equal(E.canPartner({ is_demo: 1 }, { is_demo: 0 }), false);
  assert.equal(E.canPartner({ is_demo: 1 }, { is_demo: 1 }), true);
  assert.equal(E.canPartner({ is_demo: 0 }, { is_demo: 0 }), true);
});
