import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-unav-")), "test.db");
delete process.env.ANTHROPIC_API_KEY;

const { createAccount } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const { run } = await import("../src/lib/db.ts");
const { addDays, dayOfWeek, formatDate, sgToday } = await import("../src/lib/dates.ts");

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const written = (iso: string) => `${+iso.slice(8)} ${MON[+iso.slice(5, 7) - 1]}`;
const PRICE = /SGD|S\$|\$\s?\d/i;

/** A Saturday 4+ weeks out, fully booked (2 jobs). */
let booth: number, otherBooth: number, kitchen: number, sat: string;
let n = 9600_0000;
const phone = () => `+65 ${++n}`;
before(() => {
  booth = createAccount({ email: "snap@test.sg", password: "password1", name: "Mel", business: "Snap & Smile", kind: "photobooth", samplePrices: true }).vendorId;
  otherBooth = createAccount({ email: "box@test.sg", password: "password1", name: "Ana", business: "Snapbox SG", kind: "photobooth", samplePrices: true }).vendorId;
  kitchen = createAccount({ email: "rk@test.sg", password: "password1", name: "Siti", business: "Rempah Kitchen", kind: "caterer", samplePrices: true }).vendorId;
  sat = addDays(sgToday(), 28);
  while (dayOfWeek(sat) !== 6) sat = addDays(sat, 1);
  for (const note of ["Lim party", "Tan wedding"]) run("INSERT INTO holds (vendor_id, date, kind, note) VALUES (?, ?, 'booking', ?)", booth, sat, note);
  run("INSERT INTO partnerships (requester_id, partner_id, status) VALUES (?, ?, 'accepted')", booth, kitchen);
});

async function clash(text = `Corporate D&D on ${written(sat)}, 6pm to 9pm at Marina Bay, around 300 pax. 360 booth please, quote?`) {
  const handle = phone();
  const { enquiryId } = E.ingest({ vendorId: booth, channel: "email", handle, email: handle + "@x.sg", text });
  await E.processEnquiry(booth, enquiryId);
  return { id: enquiryId, handle, draft: E.pendingDraft(enquiryId)!, e: E.getEnquiry(booth, enquiryId)! };
}

test("alternative dates are free, within a week, the same kind of day, and never in the past", () => {
  const v = E.getVendor(booth)!;
  run("INSERT INTO holds (vendor_id, date, kind, note) VALUES (?, ?, 'block', 'Away')", booth, addDays(sat, 1)); // Sunday blocked
  try {
    const alts = E.alternativeDates(v, sat);
    assert.equal(alts.length, 2);
    for (const d of alts) {
      assert.equal(E.availability(v, d).available, true);
      assert.ok(Math.abs((new Date(d).getTime() - new Date(sat).getTime()) / 86400_000) <= 7);
      assert.ok([0, 5, 6].includes(dayOfWeek(d)), `${d} is a weekend day like the Saturday`);
    }
    assert.ok(alts.includes(addDays(sat, -1)), "the Friday before");
    assert.ok(!alts.includes(addDays(sat, 1)), "not the blocked Sunday");
    assert.deepEqual(E.alternativeDates(v, addDays(sgToday(), 2), undefined, 2, sgToday()).filter((d) => d <= sgToday()), []);
    assert.match(E.formatDateChoice(["2026-11-20", "2026-11-22"]), /^Fri 20 or Sun 22 Nov$/);
  } finally {
    run("DELETE FROM holds WHERE vendor_id = ? AND kind = 'block'", booth);
  }
});

test("a booked date: other dates offered, no price anywhere, not counted as quoted", async () => {
  const { draft, e } = await clash();
  assert.equal(draft.purpose, "unavailable");
  const fri = formatDate(addDays(sat, -1)).replace(",", "").replace(/\s+\S+$/, "");
  assert.match(draft.body, new RegExp(`I'm free on ${fri} or Sun \\d+ \\w+, would either work\\?`));
  assert.doesNotMatch(draft.body, PRICE);
  assert.equal(e.quote, null, "no quote card total");
  assert.doesNotMatch(draft.body, /partner/i, "no photobooth partner yet, and caterers can't cover the date");
  E.markDraftSentManually(booth, draft.id);
  assert.equal(E.getEnquiry(booth, e.id)!.status, "awaiting_info", "the lead stays open");
  assert.equal(E.stats(booth).quotesSent, 0);
  const page = readFileSync("src/app/app/inbox/[id]/page.tsx", "utf8");
  assert.match(page, /Not quoted: date unavailable/);
  assert.match(page, /defaultValue=\{dateUnavailable \? "" : q\?\.total \?\? ""\}/, "booking value isn't pre-filled");
});

test("a same-category partner is offered for the fixed date; named with a price only if they share it", async () => {
  run("INSERT INTO partnerships (requester_id, partner_id, status) VALUES (?, ?, 'accepted')", booth, otherBooth);
  const unnamed = await clash();
  assert.match(unnamed.draft.body, /If the \d+(st|nd|rd|th) is fixed, I can connect you with a trusted partner who may be free that evening\./);
  assert.doesNotMatch(unnamed.draft.body, /Snapbox|PRICE/);
  run("UPDATE vendors SET share_from_price = 1 WHERE id = ?", otherBooth);
  const named = await clash();
  assert.match(named.draft.body, /our trusted partner Snapbox SG \(photobooth, from SGD 450\) may be free that evening/);
  run("UPDATE vendors SET bundle_suggestions = 0 WHERE id = ?", booth);
  const off = await clash();
  assert.doesNotMatch(off.draft.body, /partner/i, "partner suggestions off");
  run("UPDATE vendors SET bundle_suggestions = 1, share_from_price = 0 WHERE id = ?", booth);
  // The referral picker lists the same-category partner first.
  assert.deepEqual(E.partnersForReferral(E.getVendor(booth)!).map((p) => p.name), ["Snapbox SG", "Rempah Kitchen"]);
});

test("quoting resumes when the planner takes a free date", async () => {
  const { id, handle, draft } = await clash();
  E.markDraftSentManually(booth, draft.id);
  E.ingest({ vendorId: booth, channel: "email", handle, text: "Friday works for us!" });
  await E.processEnquiry(booth, id);
  const e = E.getEnquiry(booth, id)!;
  assert.equal(e.event_date, addDays(sat, -1), "the offered Friday");
  assert.equal(E.pendingDraft(id)!.purpose, "quote");
  assert.ok(E.parseQuote(e)!.total > 0);

  // Or by writing a new date out in full.
  const b = await clash();
  E.markDraftSentManually(booth, b.draft.id);
  E.ingest({ vendorId: booth, channel: "email", handle: b.handle, text: `Could we do ${written(addDays(sat, 7))} instead?` });
  await E.processEnquiry(booth, b.id);
  assert.equal(E.getEnquiry(booth, b.id)!.event_date, addDays(sat, 7));
  assert.equal(E.pendingDraft(b.id)!.purpose, "quote");
});
