import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-eq-")), "test.db");
for (const k of ["ANTHROPIC_API_KEY", "SMTP_HOST", "RESEND_API_KEY"]) delete process.env[k];

const { createAccount } = await import("../src/lib/accounts.ts");
const EQ = await import("../src/lib/equipment.ts");
const E = await import("../src/lib/engine.ts");
const { run, get } = await import("../src/lib/db.ts");

let mel: number, ali: number;
const item = (vendorId: number, name: string, kind = "package") =>
  run("INSERT INTO items (vendor_id, kind, name, pricing, price, included_hours) VALUES (?, ?, ?, 'flat', 500, 2)", vendorId, kind, name);

before(() => {
  mel = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth" }).vendorId;
  ali = createAccount({ email: "ali@x.sg", password: "password1", name: "Ali", business: "Ali Booths", kind: "photobooth" }).vendorId;
});

test("equipment needs a name and a quantity of at least 1, and belongs to one vendor", () => {
  assert.throws(() => EQ.addEquipment(mel, "  ", 2), /Give the equipment a name/);
  for (const q of [0, -1, 1.5]) assert.throws(() => EQ.addEquipment(mel, "360 booth", q), /at least 1/);
  const id = EQ.addEquipment(mel, " 360   booth ", 2);
  assert.equal(EQ.listEquipment(mel)[0].name, "360 booth");
  assert.throws(() => EQ.addEquipment(mel, "360 BOOTH", 1), /already have/);
  assert.deepEqual(EQ.listEquipment(ali), [], "never another vendor's");
  assert.equal(EQ.ownEquipmentId(ali, id), null, "a vendor can't link another vendor's equipment");
  assert.equal(EQ.ownEquipmentId(mel, String(id)), id);
  assert.equal(EQ.ownEquipmentId(mel, ""), null);
  assert.throws(() => EQ.updateEquipment(ali, id, "Mine now", 5), /not found/);
});

test("deleting equipment unlinks the items that used it", () => {
  const eq = EQ.addEquipment(mel, "Mirror booth", 1);
  const a = item(mel, "Mirror Booth 2h");
  const b = item(mel, "Mirror Booth 3h");
  run("UPDATE items SET equipment_id = ? WHERE id IN (?, ?)", eq, a, b);
  assert.deepEqual(EQ.itemsUsing(mel, eq).map((i) => i.name), ["Mirror Booth 2h", "Mirror Booth 3h"]);
  assert.equal(EQ.deleteEquipment(mel, eq), 2);
  assert.equal(get<{ equipment_id: number | null }>("SELECT equipment_id FROM items WHERE id = ?", a)!.equipment_id, null);
  assert.ok(get("SELECT 1 FROM items WHERE id = ?", b), "the items themselves stay");
});

test("suggestions: one per package family, nothing created until confirmed", () => {
  const v = createAccount({ email: "s@x.sg", password: "password1", name: "S", business: "S Co", kind: "photobooth" }).vendorId;
  for (const n of ["Classic Booth 2h", "Classic Booth 3h", "Classic Booth 4 hours", "360 Video Booth 3h"]) item(v, n);
  item(v, "Guestbook album", "addon");
  const s = EQ.suggestEquipment(E.getItems(v));
  assert.deepEqual(s.map((x) => [x.name, x.itemNames.length]), [["Classic Booth", 3], ["360 Video Booth", 1]]);
  assert.deepEqual(EQ.listEquipment(v), []);
  EQ.addSuggestedEquipment(v, [{ name: "Print booth", quantity: 6, itemIds: s[0].itemIds }]);
  const [print] = EQ.listEquipment(v);
  assert.deepEqual([print.name, print.quantity], ["Print booth", 6]);
  assert.equal(E.getItems(v).filter((i) => i.equipment_id === print.id).length, 3);
  assert.equal(E.getItems(v).find((i) => i.name === "360 Video Booth 3h")!.equipment_id, null, "unticked: left alone");
});

test("an empty daily most means no day limit only when the vendor lists equipment", () => {
  assert.equal(E.dayCap({ jobs_per_day: 0 }, true), Infinity);
  assert.equal(E.dayCap({ jobs_per_day: 0 }, false), 1, "nobody without equipment is suddenly unlimited");
  assert.equal(E.dayCap({ jobs_per_day: 3 }, true), 3);
  assert.equal(E.dayCap({ jobs_per_day: 3 }, false), 3);
});

test("a vendor with no equipment is unchanged: same availability as before", () => {
  const v = E.getVendor(ali)!;
  assert.equal(EQ.hasEquipment(ali), false);
  const date = "2027-03-06";
  assert.equal(E.availability(v, date).available, true);
  for (let n = 0; n < v.jobs_per_day; n++) run("INSERT INTO holds (vendor_id, date, kind, note) VALUES (?, ?, 'booking', 'x')", ali, date);
  assert.equal(E.availability(v, date).available, false, "the jobs-per-day counter, as before");
});
