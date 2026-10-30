import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SETTINGS_TABS, notesPlaceholder, settingsUpdate, tabFromHash } from "../src/lib/settings-tabs.ts";
import type { Vendor } from "../src/lib/types.ts";

const vendor = { name: "Snap & Smile", kind: "photobooth", tone: "Friendly", is_demo: 0 } as Vendor;
const form = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });

// Every field on the page, filled in, so each tab must pick out only its own.
const everything = form({
  name: "New name", kind: "caterer", tone: "Warm", signoff: "Mel", notes: "2m x 3m space",
  jobs_per_day: "3", hold_hours: "24", followup_days: "1", min_spend: "500", offpeak_discount: "15", capacity: "200", deposit_note: "30% deposit",
  bundle_suggestions: "on", share_from_price: "on", referral_fee_pct: "12",
  auto_send: "on", wa_phone_number_id: "123", wa_token: "EAAGsecret", wa_disconnect: "on", wa_templates_approved: "on",
});

test("each tab saves only its own fields", () => {
  const keys = (t: Parameters<typeof settingsUpdate>[0]) => Object.keys(settingsUpdate(t, everything, vendor)).sort();
  assert.deepEqual(keys("business"), ["kind", "name", "notes", "signoff", "tone"]);
  assert.deepEqual(keys("bookings"), ["capacity", "deposit_note", "followup_days", "hold_hours", "jobs_per_day", "min_spend", "offpeak_discount"]);
  assert.deepEqual(keys("partners"), ["bundle_suggestions", "referral_fee_pct", "share_from_price"]);
  assert.deepEqual(keys("ai"), ["auto_send", "brief_hours", "brief_questions", "pricing_mode", "qualify_fields"]);
  assert.deepEqual(keys("channels"), []);
  assert.deepEqual(keys("account"), []);
});

test("no tab writes channel connections or template approval", () => {
  for (const t of SETTINGS_TABS) {
    const cols = Object.keys(settingsUpdate(t.id, everything, vendor));
    assert.ok(!cols.some((c) => c.startsWith("wa_") || c === "inbound_token"), `${t.id} wrote ${cols}`);
  }
});

test("an unticked checkbox saves as off, and limits still apply", () => {
  const p = settingsUpdate("partners", form({ referral_fee_pct: "80" }), vendor);
  assert.deepEqual(p, { bundle_suggestions: 0, share_from_price: 0, referral_fee_pct: 50 });
  const b = settingsUpdate("bookings", form({ jobs_per_day: "0", hold_hours: "", offpeak_discount: "200" }), vendor);
  assert.equal(b.jobs_per_day, 1);
  assert.equal(b.hold_hours, 48);
  assert.equal(b.offpeak_discount, 90);
  assert.equal(b.capacity, null);
});

test("auto-send stays off on demo accounts", () => {
  assert.equal(settingsUpdate("ai", form({ auto_send: "on" }), { ...vendor, is_demo: 1 }).auto_send, 0);
  assert.equal(settingsUpdate("ai", form({ auto_send: "on" }), vendor).auto_send, 1);
});

test("old and new addresses open the right tab", () => {
  assert.equal(tabFromHash(""), "business");
  assert.equal(tabFromHash(null), "business");
  assert.equal(tabFromHash("#channels"), "channels");
  assert.equal(tabFromHash("#ai"), "ai");
  assert.equal(tabFromHash("#password"), "account");
  assert.equal(tabFromHash("#Bookings"), "bookings");
  assert.equal(tabFromHash("#nonsense"), "business");
});

test("the notes example depends on the category", () => {
  assert.match(notesPlaceholder("photobooth"), /^Example: We need a 2m x 3m space/);
  assert.match(notesPlaceholder("caterer"), /^Example: Minimum 50 pax/);
  assert.match(notesPlaceholder("venue"), /^Example: Max 200 standing/);
  for (const k of ["av", "decor", "emcee", "photography", "other"] as const) assert.match(notesPlaceholder(k), /^Example: .*space.*[Ss]etup.*deposit.*Travel.*don't/);
});

test("the settings page gives every saving tab its own form and Save", () => {
  const page = readFileSync("src/app/app/settings/page.tsx", "utf8");
  for (const t of ["business", "bookings", "partners", "ai"]) assert.match(page, new RegExp(`<TabForm tab="${t}"`));
  assert.match(page, /What Matchire should know about your business/);
  assert.ok(!page.includes("Things Matchire should know"));
});
