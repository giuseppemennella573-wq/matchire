import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-def-")), "test.db");
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "SMTP_HOST", "RESEND_API_KEY", "WHATSAPP_WABA_ID", "WHATSAPP_SYSTEM_TOKEN"]) delete process.env[k];

const { createAccount } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const T = await import("../src/lib/templates-status.ts");
const { run, get } = await import("../src/lib/db.ts");
const { addDays, sgToday } = await import("../src/lib/dates.ts");

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (n: number) => { const [, m, d] = addDays(sgToday(), n).split("-"); return `${+d} ${MON[+m - 1]}`; };
let booth: number;
let n = 0;
const enquire = async (vendorId: number, text: string) => {
  const { enquiryId } = E.ingest({ vendorId, channel: "whatsapp", handle: `+65 9200 ${String(1000 + n++)}`, text });
  await E.processEnquiry(vendorId, enquiryId);
  return { e: E.getEnquiry(vendorId, enquiryId)!, body: E.pendingDraft(enquiryId)!.body };
};

before(() => {
  booth = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth", samplePrices: true }).vendorId;
});

test("new accounts start with a 30% deposit, stated in the quote; the column default leaves existing accounts alone", async () => {
  assert.equal(E.getVendor(booth)!.deposit_pct, 30);
  const { body, e } = await enquire(booth, `Classic booth on ${day(30)} evening, 80 guests, 2 hours`);
  const total = E.parseQuote(e)!.total;
  assert.match(body, new RegExp(`A deposit of SGD ${Math.round(total * 0.3)} \\(30%\\) secures the date`));
  // Rows not created through createAccount (e.g. existing accounts) keep no deposit: nothing changes for them silently.
  const old = run("INSERT INTO vendors (name, kind, slug, inbound_token) VALUES ('Old Co', 'photobooth', 'old-co', 'tok-old')");
  assert.equal(get<{ deposit_pct: number | null }>("SELECT deposit_pct FROM vendors WHERE id = ?", old)!.deposit_pct, null);
});

test("add-ons: 'always' goes in every quote, 'offer' is mentioned but not added, 'asked' only when asked", async () => {
  const setup = get<{ add_rule: string }>("SELECT add_rule FROM items WHERE vendor_id = ? AND name = 'Setup & transport'", booth)!;
  assert.equal(setup.add_rule, "always", "the sample list adds setup & transport");
  run("UPDATE items SET add_rule = 'offer' WHERE vendor_id = ? AND name = 'Guestbook album'", booth);
  const { e, body } = await enquire(booth, `Classic booth on ${day(31)} evening, 80 guests, 2 hours`);
  const q = E.parseQuote(e)!;
  assert.ok(q.lines.some((l) => l.label.startsWith("Setup & transport")), "always added");
  assert.ok(!q.lines.some((l) => l.label.startsWith("Guestbook album")), "offered, not added");
  assert.ok(!q.lines.some((l) => l.label.startsWith("Custom print frame")), "asked-only: not asked");
  assert.equal(q.total, 450 + 60);
  assert.match(body, /Guestbook album is SGD 120 if you'd like it\./);
  assert.equal(E.offerSentence([{ name: "A", price: 60, pricing: "flat" }, { name: "B", price: 25, pricing: "per_pax" }] as never), "Also available if you'd like them: A (SGD 60) and B (SGD 25 per guest).");
});

test("WhatsApp templates: the manual tick for the vendor's own account; Meta's real status for Matchire's WABA", async () => {
  const v = () => E.getVendor(booth)!;
  assert.deepEqual(T.templateStatus(v()), { source: "manual", approved: false });
  assert.equal(T.describeStatus(T.templateStatus(v())), "not approved yet");

  process.env.WHATSAPP_WABA_ID = "1234567890";
  run("UPDATE vendors SET wa_token = 'EAAtest' WHERE id = ?", booth);
  let calls = 0;
  const meta = (statuses: Record<string, string>) => (async (url: string | URL, init?: RequestInit) => {
    calls++;
    assert.match(String(url), /\/1234567890\/message_templates\?/);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer EAAtest");
    return Response.json({ data: Object.entries(statuses).map(([name, status]) => ({ name, status, language: "en" })) });
  }) as typeof fetch;
  const t0 = new Date("2026-11-05T01:00:00Z");
  let s = await T.refreshTemplateStatus(v(), t0, meta({ quote_nudge: "APPROVED", quote_last_call: "PENDING" }));
  assert.equal(s.source, "meta");
  assert.equal(s.approved, false);
  assert.equal(T.describeStatus(s), "waiting for Meta's approval");
  // Cached for an hour.
  await T.refreshTemplateStatus(v(), new Date(t0.getTime() + 30 * 60_000), meta({ quote_nudge: "APPROVED", quote_last_call: "APPROVED" }));
  assert.equal(calls, 1);
  s = await T.refreshTemplateStatus(v(), new Date(t0.getTime() + 61 * 60_000), meta({ quote_nudge: "APPROVED", quote_last_call: "APPROVED" }));
  assert.equal(calls, 2);
  assert.equal(s.approved, true, "approved by Meta, though the manual tick is off");
  assert.equal(T.describeStatus(s), "approved by Meta");
  assert.equal(T.templateStatus(v()).approved, true, "follow-ups use it without asking Meta again");

  // The vendor's own WABA: back to the manual tick.
  run("UPDATE vendors SET wa_matchire_waba = 0 WHERE id = ?", booth);
  assert.deepEqual(T.templateStatus(v()), { source: "manual", approved: false });
  run("UPDATE vendors SET wa_matchire_waba = 1, wa_token = NULL WHERE id = ?", booth);
  delete process.env.WHATSAPP_WABA_ID;
});

test("'Get set up' asks to confirm the deposit, hold and referral fee (the 10% value is unchanged)", () => {
  assert.equal(E.getVendor(booth)!.referral_fee_pct, 10);
  const page = readFileSync("src/app/app/page.tsx", "utf8");
  assert.match(page, /Confirm your booking terms/);
  assert.match(page, /<b>Referral fee:<\/b> \{vendor\.referral_fee_pct\}%/);
  assert.match(page, /<b>Deposit:<\/b>/);
});
