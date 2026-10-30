import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-xh-")), "test.db");
delete process.env.ANTHROPIC_API_KEY;

const { createAccount, addItems } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const { applyCardExtraHour, buildQuote } = await import("../src/lib/pricing.ts");
const { addDays, sgToday } = await import("../src/lib/dates.ts");
import type { Item } from "../src/lib/types.ts";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (n: number) => { const [, m, d] = addDays(sgToday(), n).split("-"); return `${+d} ${MON[+m - 1]}`; };
const pkg = (o: Partial<Item>): Item => ({ id: 1, vendor_id: 1, kind: "package", name: "P", description: "", pricing: "flat", price: 0, included_hours: null, extra_hour_price: null, min_pax: null, max_pax: null, active: 1, sort: 0, ...o });
const vendor = { min_spend: 0, offpeak_discount: 0, capacity: null };

let booth: number;
before(() => {
  booth = createAccount({ email: "xh@test.sg", password: "password1", name: "Mel", business: "Snap", kind: "photobooth" }).vendorId;
  const base = { kind: "package" as const, pricing: "flat" as const, description: "", min_pax: null, max_pax: null };
  addItems(booth, [
    { ...base, name: "Classic Booth 2h", price: 650, included_hours: 2, extra_hour_price: 180 },
    { ...base, name: "Classic Booth 4h", price: 1050, included_hours: 4, extra_hour_price: 180 },
    { ...base, name: "360 Video Booth 3h", price: 1200, included_hours: 3, extra_hour_price: 350 },
    { ...base, name: "Mirror Booth 2h", price: 900, included_hours: 2, extra_hour_price: null },
  ]);
});

test("longer than the package: that package's own extra-hour rate", () => {
  const classic = buildQuote({ vendor, pkg: pkg({ name: "Classic Booth 4h", price: 1050, included_hours: 4, extra_hour_price: 180 }), addons: [], hours: 5, pax: null, date: null, slot: null });
  assert.deepEqual(classic.lines.map((l) => [l.label, l.amount]), [["Classic Booth 4h · 4h", 1050], ["Extra 1h", 180]]);
  assert.equal(classic.total, 1230);
  const video = buildQuote({ vendor, pkg: pkg({ name: "360 Video Booth 3h", price: 1200, included_hours: 3, extra_hour_price: 350 }), addons: [], hours: 3.5, pax: null, date: null, slot: null });
  assert.equal(video.total, 1200 + 175, "half an hour at 350/h");
  assert.equal(video.unpriced_hours, undefined);
});

test("no extra-hour rate: no invented price, the reply says it'll be confirmed, and it waits for the vendor", async () => {
  const q = buildQuote({ vendor, pkg: pkg({ name: "Mirror Booth 2h", price: 900, included_hours: 2 }), addons: [], hours: 3, pax: null, date: null, slot: null });
  assert.equal(q.total, 900);
  assert.equal(q.unpriced_hours, 1);
  assert.match(q.issues[0], /no extra-hour rate/);

  const { enquiryId } = E.ingest({ vendorId: booth, channel: "whatsapp", handle: "+65 9700 0001", text: `Mirror booth for my party on ${day(30)} evening, 60 guests, 3 hours` });
  const r = await E.processEnquiry(booth, enquiryId);
  const body = E.pendingDraft(enquiryId)!.body;
  assert.match(body, /Mirror Booth 2h · 2h: SGD 900/);
  assert.match(body, /I'll confirm the price for the extra 1h/);
  assert.doesNotMatch(body, /Extra 1h:/);
  assert.match(r.ownerReason!, /no extra-hour rate/, "flagged for approval");
});

test("a 5-hour Classic Booth request is priced from the 4h package plus one extra hour", async () => {
  const { enquiryId } = E.ingest({ vendorId: booth, channel: "whatsapp", handle: "+65 9700 0002", text: `Classic booth for our wedding on ${day(31)} evening, 120 guests, 5 hours` });
  await E.processEnquiry(booth, enquiryId);
  const q = E.parseQuote(E.getEnquiry(booth, enquiryId)!)!;
  assert.equal(q.lines[0].label, "Classic Booth 4h · 4h");
  assert.equal(q.total, 1230);
});

test("import: per-package rates stay; one rate for the whole card fills the gaps", () => {
  const items = [
    { kind: "package", pricing: "flat", included_hours: 2, extra_hour_price: 200 },
    { kind: "package", pricing: "flat", included_hours: 3, extra_hour_price: null },
    { kind: "package", pricing: "per_pax", included_hours: null, extra_hour_price: null },
    { kind: "addon", pricing: "flat", included_hours: null, extra_hour_price: null },
  ] as Pick<Item, "kind" | "pricing" | "included_hours" | "extra_hour_price">[];
  assert.equal(applyCardExtraHour(items, 150), 1);
  assert.deepEqual(items.map((i) => i.extra_hour_price), [200, 150, null, null]);
  assert.equal(applyCardExtraHour(items, null), 0);
});

test("an imported card with one extra-hour rate: saved for review with the rate on each package", async () => {
  const { saveImportedRateCard } = await import("../src/lib/accounts.ts");
  const { get, all } = await import("../src/lib/db.ts");
  const v = createAccount({ email: "imp@test.sg", password: "password1", name: "I", business: "Imp", kind: "photobooth" }).vendorId;
  const base = { kind: "package" as const, pricing: "flat" as const, description: "", min_pax: null, max_pax: null };
  const msg = saveImportedRateCard(v, {
    items: [
      { ...base, name: "Basic 2h", price: 400, included_hours: 2, extra_hour_price: null },
      { ...base, name: "Premium 3h", price: 700, included_hours: 3, extra_hour_price: 220 },
    ],
    extra_hour_price_all: 150,
    notes: "",
  });
  assert.match(msg, /extra-hour rate \(SGD 150\) was applied to 1 package: check it/);
  assert.deepEqual(all<{ name: string; extra_hour_price: number; active: number }>("SELECT name, extra_hour_price, active FROM items WHERE vendor_id = ? ORDER BY id", v).map((r) => ({ ...r })),
    [{ name: "Basic 2h", extra_hour_price: 150, active: 0 }, { name: "Premium 3h", extra_hour_price: 220, active: 0 }]);
  assert.ok(get("SELECT 1 FROM items WHERE vendor_id = ? AND active = 0", v), "nothing goes live until the vendor approves");
});
