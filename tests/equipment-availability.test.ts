import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-eqa-")), "test.db");
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "SMTP_HOST", "RESEND_API_KEY"]) delete process.env[k];

const { createAccount } = await import("../src/lib/accounts.ts");
const EQ = await import("../src/lib/equipment.ts");
const E = await import("../src/lib/engine.ts");
const { run, get, all } = await import("../src/lib/db.ts");
const { addDays, sgToday, dayOfWeek, formatDate } = await import("../src/lib/dates.ts");

let v: number, print: number, b360: number, classic: number, pkg360: number;
// A Saturday about five weeks out.
let sat = addDays(sgToday(), 35);
while (dayOfWeek(sat) !== 6) sat = addDays(sat, 1);
const long = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-SG", { day: "numeric", month: "long", timeZone: "UTC" });

const book = (date: string, equipmentId: number, kind = "booking", expires: string | null = null) => {
  const h = run("INSERT INTO holds (vendor_id, date, kind, note, expires_at) VALUES (?, ?, ?, 'x', ?)", v, date, kind, expires);
  run("INSERT INTO hold_equipment (hold_id, equipment_id, units) VALUES (?, ?, 1)", h, equipmentId);
  return h;
};
let n = 0;
async function enquire(text: string) {
  const { enquiryId } = E.ingest({ vendorId: v, channel: "whatsapp", text, name: "Pat", handle: `+65 9100 ${String(1000 + n++)}` });
  await E.processEnquiry(v, enquiryId);
  return { e: E.getEnquiry(v, enquiryId)!, draft: E.pendingDraft(enquiryId)! };
}

before(() => {
  v = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth" }).vendorId;
  run("UPDATE vendors SET jobs_per_day = 0, bundle_suggestions = 0 WHERE id = ?", v);
  print = EQ.addEquipment(v, "Print booth", 6);
  b360 = EQ.addEquipment(v, "360 booth", 2);
  classic = run("INSERT INTO items (vendor_id, kind, name, pricing, price, included_hours, extra_hour_price, equipment_id, sort) VALUES (?, 'package', 'Classic Booth 3h', 'flat', 850, 3, 180, ?, 1)", v, print);
  pkg360 = run("INSERT INTO items (vendor_id, kind, name, pricing, price, included_hours, extra_hour_price, equipment_id, sort) VALUES (?, 'package', '360 Booth 3h', 'flat', 1200, 3, 350, ?, 2)", v, b360);
  run("INSERT INTO items (vendor_id, kind, name, pricing, price, sort) VALUES (?, 'addon', 'Guestbook album', 'flat', 150, 3)", v);
});

test("both 360 booths out: a third 360 enquiry gets the free Classic with its real price, and the 360's free dates", async () => {
  book(sat, b360);
  book(sat, b360);
  const vendor = E.getVendor(v)!;
  assert.equal(E.availability(vendor, sat, undefined, E.needsFor([{ equipment_id: b360 }])).available, false);
  assert.equal(E.availability(vendor, sat, undefined, E.needsFor([{ equipment_id: print }])).available, true);
  assert.equal(E.availability(vendor, sat).available, true, "the day itself is open: print booths are free");

  const { e, draft } = await enquire(`Hi! Can I book the 360 booth for 3 hours on ${long(sat)}, 7pm, about 100 guests at Marina Bay?`);
  assert.equal(draft.purpose, "unavailable");
  assert.match(draft.body, new RegExp(`Our 360 booth is taken on ${formatDate(sat).replace(",", "")}, but our Classic Booth 3h is free that day: SGD 850\\.`));
  assert.match(draft.body, /If you'd prefer the 360 booth, it's free on .+\./);
  assert.doesNotMatch(draft.body, /SGD 1,200/, "the 360 isn't priced for a day it's taken");
  assert.equal(e.quote, null);
  assert.match(e.owner_reason ?? "", /Your 360 booth is fully booked/);
  // The dates offered really have a free 360.
  for (const d of E.parseDetails(e).alternatives ?? []) {
    assert.equal(E.availability(vendor, d, e.id, E.needsFor([{ equipment_id: b360 }])).available, true, d);
  }
});

test("a print-booth enquiry for that same day is quoted normally, and the hold takes a print booth", async () => {
  const { e, draft } = await enquire(`Hi, Classic booth 3 hours on ${long(sat)} evening for 80 guests at Tampines, how much?`);
  assert.equal(draft.purpose, "quote");
  assert.match(draft.body, /SGD 850/);
  await E.markDraftSentManually(v, draft.id);
  const hold = get<{ id: number }>("SELECT id FROM holds WHERE enquiry_id = ? AND status = 'active'", e.id)!;
  assert.deepEqual(all<{ equipment_id: number; units: number }>("SELECT equipment_id, units FROM hold_equipment WHERE hold_id = ?", hold.id).map((r) => ({ ...r })), [{ equipment_id: print, units: 1 }]);
  const a = E.availability(E.getVendor(v)!, sat);
  assert.deepEqual(a.equipment.map((q) => [q.name, q.used, q.quantity]), [["Print booth", 1, 6], ["360 booth", 2, 2]]);
});

test("a held unit is free again once the hold expires", () => {
  const d = addDays(sat, 7);
  const h1 = book(d, b360, "hold", new Date(Date.now() + 3600_000).toISOString());
  book(d, b360);
  const vendor = E.getVendor(v)!;
  const needs = E.needsFor([{ equipment_id: b360 }]);
  assert.equal(E.availability(vendor, d, undefined, needs).available, false);
  run("UPDATE holds SET status = 'expired' WHERE id = ?", h1);
  assert.equal(E.availability(vendor, d, undefined, needs).available, true);
});

test("the daily cap still applies when it's set, and a blocked day is closed for everything", () => {
  const d = addDays(sat, 14);
  book(d, print);
  book(d, print);
  const vendor = () => E.getVendor(v)!;
  const needsPrint = E.needsFor([{ equipment_id: print }]);
  assert.equal(E.availability(vendor(), d, undefined, needsPrint).available, true, "no cap: 4 print booths still free");
  run("UPDATE vendors SET jobs_per_day = 2 WHERE id = ?", v);
  assert.equal(E.availability(vendor(), d, undefined, needsPrint).available, false, "cap of 2 jobs reached");
  run("UPDATE vendors SET jobs_per_day = 0 WHERE id = ?", v);
  const d2 = addDays(sat, 21);
  E.blockDate(v, d2, "Away");
  assert.equal(E.availability(vendor(), d2, undefined, needsPrint).available, false);
  assert.equal(E.availability(vendor(), d2).blocked, true);
});

test("upsell and cheaper options only offer packages whose equipment is free that day", () => {
  const vendor = E.getVendor(v)!;
  const free = E.freeItems(vendor, sat, E.getItems(v));
  assert.ok(free.some((i) => i.id === classic));
  assert.ok(!free.some((i) => i.id === pkg360), "the 360 is full on that Saturday");
  assert.ok(free.some((i) => i.name === "Guestbook album"), "items without equipment are always free");
});

test("a vendor without equipment behaves exactly as before", () => {
  const other = createAccount({ email: "plain@x.sg", password: "password1", name: "P", business: "Plain Co", kind: "photobooth" }).vendorId;
  run("UPDATE vendors SET jobs_per_day = 1 WHERE id = ?", other);
  const vendor = E.getVendor(other)!;
  assert.equal(E.dayCap(vendor, false), 1);
  run("INSERT INTO holds (vendor_id, date, kind, note) VALUES (?, ?, 'booking', 'x')", other, sat);
  assert.equal(E.availability(vendor, sat).available, false);
  run("UPDATE vendors SET jobs_per_day = 0 WHERE id = ?", other);
  assert.equal(E.dayCap(E.getVendor(other)!, false), 1, "an empty cap without equipment still means one job a day");
});

// ---------- Step 4: calendar ----------

test("the day summary counts bookings and active holds per equipment, not expired holds or other vendors", () => {
  const d = addDays(sat, 28);
  book(d, print);
  const expired = book(d, print, "hold");
  run("UPDATE holds SET status = 'expired' WHERE id = ?", expired);
  const other = createAccount({ email: "o@x.sg", password: "password1", name: "O", business: "O Co", kind: "photobooth" }).vendorId;
  const theirs = EQ.addEquipment(other, "Print booth", 1);
  run("INSERT INTO hold_equipment (hold_id, equipment_id, units) VALUES (?, ?, 1)", run("INSERT INTO holds (vendor_id, date, kind, note) VALUES (?, ?, 'booking', 'theirs')", other, d), theirs);
  const a = E.availability(E.getVendor(v)!, d);
  assert.deepEqual(a.equipment.map((q) => [q.name, q.used]), [["Print booth", 1], ["360 booth", 0]]);
  assert.deepEqual([...E.holdEquipmentNames([expired]).values()], [["Print booth"]]);
});

test("a manual booking with equipment takes a unit, and is refused when that equipment is all out", () => {
  const d = addDays(sat, 35);
  E.addManualBooking(v, d, "Koh wedding", b360);
  E.addManualBooking(v, d, "Lee party", b360);
  assert.equal(E.availability(E.getVendor(v)!, d).equipment.find((q) => q.id === b360)!.free, 0);
  assert.throws(() => E.addManualBooking(v, d, "One too many", b360), /All 2 of your 360 booths are already out/);
  E.addManualBooking(v, d, "Print job", print);
  E.addManualBooking(v, d, "No equipment", null);
  assert.equal(E.availability(E.getVendor(v)!, d).used, 4);
  E.blockDate(v, addDays(d, 1), "Away");
  assert.throws(() => E.addManualBooking(v, addDays(d, 1), "x", print), /is blocked/);
});
