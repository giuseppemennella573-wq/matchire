import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuote, unknownAmounts, allowedAmounts } from "../src/lib/pricing.ts";
import { resolveDate, isOffPeak } from "../src/lib/dates.ts";
import { parseEnquiry } from "../src/lib/heuristics.ts";
import type { Item } from "../src/lib/types.ts";

const item = (o: Partial<Item>): Item => ({
  id: 1, vendor_id: 1, kind: "package", name: "Classic booth", description: "", pricing: "flat", price: 450,
  included_hours: 2, extra_hour_price: 120, min_pax: null, max_pax: null, active: 1, sort: 0, ...o,
});
const vendor = { min_spend: 0, offpeak_discount: 0, capacity: null };

test("flat package with extra hours and add-on", () => {
  const q = buildQuote({ vendor, pkg: item({}), addons: [item({ id: 2, kind: "addon", name: "Frame", price: 80, included_hours: null })], hours: 3, pax: 80, date: "2026-11-14", slot: "evening" });
  assert.deepEqual(q.lines.map((l) => l.amount), [450, 120, 80]);
  assert.equal(q.total, 650);
  assert.deepEqual(q.issues, []);
});

test("per-pax minimum is enforced and flagged", () => {
  const q = buildQuote({ vendor, pkg: item({ pricing: "per_pax", price: 32, min_pax: 30, included_hours: null }), addons: [], hours: null, pax: 20, date: null, slot: null });
  assert.equal(q.total, 960);
  assert.equal(q.issues.length, 1);
});

test("off-peak discount applies to weekday daytime package only", () => {
  // 2026-10-27 is a Tuesday
  const q = buildQuote({ vendor: { ...vendor, offpeak_discount: 25 }, pkg: item({ pricing: "per_hour", price: 280, included_hours: 3 }), addons: [item({ id: 3, kind: "addon", name: "Cleaning", price: 80, included_hours: null })], hours: 4, pax: 35, date: "2026-10-27", slot: "afternoon" });
  assert.equal(q.offpeak, true);
  assert.equal(q.lines[0].full, 1120);
  assert.equal(q.lines[0].amount, 840);
  assert.equal(q.total, 920);
});

test("minimum spend tops up", () => {
  const q = buildQuote({ vendor: { ...vendor, min_spend: 800 }, pkg: item({ pricing: "per_hour", price: 100, included_hours: 2 }), addons: [], hours: 2, pax: 10, date: null, slot: null });
  assert.equal(q.total, 800);
});

test("price guardrail catches invented amounts", () => {
  const allowed = allowedAmounts({ package_id: 1, lines: [{ label: "x", amount: 450 }], total: 450, offpeak: false, issues: [] }, [], []);
  assert.deepEqual(unknownAmounts("Your quote is SGD 450 all-in", allowed), []);
  assert.deepEqual(unknownAmounts("Special price $399 just for you", allowed), [399]);
  assert.deepEqual(unknownAmounts("Budget of 1.2k? We can do S$1,200", allowed), [1200]);
});

test("date resolution", () => {
  const today = "2026-10-24"; // Saturday
  assert.equal(resolveDate("for Sat 15 Nov evening", today).date, "2026-11-15");
  assert.equal(resolveDate("next tuesday afternoon", today).date, "2026-10-27");
  assert.equal(resolveDate("tomorrow morning", today).date, "2026-10-25");
  assert.equal(resolveDate("our wedding on 7 Dec", today).date, "2026-12-07");
  assert.equal(resolveDate("12 March", today).date, "2027-03-12");
  const vague = resolveDate("early Dec, 250 pax", today);
  assert.equal(vague.date, "2026-12-01");
  assert.equal(vague.approximate, true);
  assert.equal(resolveDate("wedding dinner, may I ask the price?", today).date, null);
  assert.equal(isOffPeak("2026-10-27", "afternoon"), true);
  assert.equal(isOffPeak("2026-10-30", "afternoon"), false);
});

test("heuristic parser reads a typical enquiry", () => {
  const items = [item({}), item({ id: 2, name: "360 booth", price: 650 }), item({ id: 3, kind: "addon", name: "Custom print frame", price: 80, included_hours: null })];
  const d = parseEnquiry("Hi! Looking for a photobooth for my daughter's 21st on Sat 15 Nov, evening, about 80 guests. 3 hours. Do you do custom print frames? Budget around $900", items, "2026-10-24");
  assert.equal(d.pax, 80);
  assert.equal(d.hours, 3);
  assert.equal(d.budget, 900);
  assert.equal(d.event_date, "2026-11-15");
  assert.equal(d.slot, "evening");
  assert.equal(d.event_type, "birthday");
  assert.deepEqual(d.addon_ids, [3]);
  const d2 = parseEnquiry("corporate D&D early Dec, 250 pax. Interested in a 360 booth for 4 hrs", items, "2026-10-24");
  assert.equal(d2.package_id, 2);
  assert.equal(d2.hours, 4);
});

test("rules mode picks the package tier that fits the hours asked for", async () => {
  const { matchPackage } = await import("../src/lib/heuristics.ts");
  const pkg = (id: number, name: string, h: number) => ({ id, vendor_id: 1, kind: "package" as const, name, description: "Unlimited prints", pricing: "flat" as const, price: 100 * h, included_hours: h, extra_hour_price: null, min_pax: null, max_pax: null, active: 1, sort: id });
  const items = [pkg(1, "Classic Booth 2h", 2), pkg(2, "Classic Booth 3h", 3), pkg(3, "Classic Booth 4h", 4)];
  assert.equal(matchPackage("need a booth for 3h please", items, 3)?.id, 2);
  assert.equal(matchPackage("booth for 2.5 hours", items, 2.5)?.id, 2, "the shortest package that covers it");
  assert.equal(matchPackage("booth for 6 hours", items, 6)?.id, 3, "nothing covers it: the longest one");
  assert.equal(matchPackage("how much for photobooth", items, null)?.id, 1, "no hours given: the first package");
});
