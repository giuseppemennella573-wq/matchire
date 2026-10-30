import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-q-")), "test.db");
delete process.env.ANTHROPIC_API_KEY;

const { createAccount } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const Q = await import("../src/lib/qualify.ts");
const { run } = await import("../src/lib/db.ts");
const { addDays, sgToday } = await import("../src/lib/dates.ts");
const { EMPTY_DETAILS } = await import("../src/lib/types.ts");

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (n: number) => { const [, m, d] = addDays(sgToday(), n).split("-"); return `${+d} ${MON[+m - 1]}`; };
/** Any price at all: "SGD 450", "$450", "450 dollars", "from 450". */
const PRICE = /SGD|S\$|\$\s?\d|\d\s?dollars|\bfrom\s+\d/i;

let booth: number;
let phone = 9300_0000;
const next = () => `+65 ${++phone}`;
before(() => {
  booth = createAccount({ email: "q@test.sg", password: "password1", name: "Ana", business: "Snapbox SG", kind: "photobooth", samplePrices: true }).vendorId;
});

async function enquire(text: string, handle = next()) {
  const { enquiryId } = E.ingest({ vendorId: booth, channel: "instagram", handle, text });
  await E.processEnquiry(booth, enquiryId);
  return { id: enquiryId, handle, draft: E.pendingDraft(enquiryId)!, e: E.getEnquiry(booth, enquiryId)! };
}

test("qualified means the date plus one more detail, or the vendor's own list", () => {
  const d = (o: object) => ({ ...EMPTY_DETAILS, ...o });
  assert.deepEqual(Q.qualification(d({})), { qualified: false, missing: ["date", "pax"] });
  assert.deepEqual(Q.qualification(d({ pax: 80 })), { qualified: false, missing: ["date"] });
  assert.deepEqual(Q.qualification(d({ event_date: "2026-12-12" })), { qualified: false, missing: ["pax"] });
  assert.equal(Q.qualification(d({ event_date: "2026-12-12", date_is_approximate: true, pax: 80 })).qualified, false, "'early Dec' isn't a date");
  for (const extra of [{ pax: 80 }, { location: "Marina Bay" }, { hours: 3 }, { event_type: "wedding" }])
    assert.equal(Q.qualification(d({ event_date: "2026-12-12", ...extra })).qualified, true, JSON.stringify(extra));
  assert.equal(Q.qualification(d({ event_date: "2026-12-12", budget: 900 })).qualified, false, "budget alone isn't enough by default");
  const req = Q.requiredFields("pax,venue,nonsense");
  assert.deepEqual(req, ["pax", "venue"]);
  assert.deepEqual(Q.qualification(d({ event_date: "2026-12-12", pax: 80 }), req), { qualified: false, missing: ["venue"] });
  assert.equal(Q.qualification(d({ event_date: "2026-12-12", pax: 80, location: "Raffles Hotel" }), req).qualified, true);
  assert.equal(Q.qualifyQuestion(["date", "pax"]), "What's the date and roughly how many guests?");
  assert.match(Q.qualifySummary(d({ event_date: "2026-12-12", pax: 120, location: "Marina Bay" })), /^Sat,? 12 Dec · 120 pax · Marina Bay$/);
});

test("'how much?' gets a warm qualifying question and no price at all", async () => {
  const { draft, e } = await enquire("hi how much for photobooth");
  assert.equal(draft.purpose, "qualify");
  assert.match(draft.body, /Happy to send exact pricing! What's the date and roughly how many guests\?/);
  assert.doesNotMatch(draft.body, PRICE);
  assert.equal(e.quote, null, "nothing is quoted, so nothing counts as quoted");
  assert.equal(e.status, "new");
});

test("a date on its own still isn't enough; a range or 'from' price never slips in", async () => {
  const { draft } = await enquire(`Photobooth available on ${day(30)}? What are your rates, from how much?`);
  assert.equal(draft.purpose, "qualify");
  assert.match(draft.body, /roughly how many guests/);
  assert.doesNotMatch(draft.body, PRICE);
  // The guardrail behind AI drafts: a qualifying reply may mention no amount at all.
  assert.equal(E.draftAllowedAmounts("qualify", null, E.getItems(booth), [450]).size, 0);
  assert.ok(E.draftAllowedAmounts("quote", null, E.getItems(booth), []).has(450));
});

test("once the planner gives the date and guest count, the normal quote follows", async () => {
  const { id, handle } = await enquire("hi how much for photobooth");
  E.markDraftSentManually(booth, E.pendingDraft(id)!.id);
  assert.equal(E.getEnquiry(booth, id)!.status, "awaiting_info");
  E.ingest({ vendorId: booth, channel: "instagram", handle, text: `It's on ${day(25)} evening, about 80 guests, 3 hours` });
  await E.processEnquiry(booth, id);
  const draft = E.pendingDraft(id)!;
  assert.equal(draft.purpose, "quote");
  assert.match(draft.body, /SGD 570/, "Classic booth 450 + 1 extra hour 120");
  assert.ok(E.parseQuote(E.getEnquiry(booth, id)!));
});

test("'Send price anyway' quotes before qualifying", async () => {
  const { id } = await enquire("hi how much for photobooth");
  await E.sendPriceAnyway(booth, id);
  const draft = E.pendingDraft(id)!;
  assert.notEqual(draft.purpose, "qualify");
  assert.match(draft.body, /SGD \d/);
  assert.equal(E.getEnquiry(booth, id)!.price_override, 1);
});

test("a booked date is said straight away, without qualifying or pricing", async () => {
  const date = addDays(sgToday(), 40);
  run("INSERT INTO holds (vendor_id, date, kind, note) VALUES (?, ?, 'block', 'Away')", booth, date);
  const [, m, d] = date.split("-");
  const { draft, e } = await enquire(`How much for a photobooth on ${+d} ${MON[+m - 1]}?`);
  assert.equal(draft.purpose, "unavailable");
  assert.doesNotMatch(draft.body, PRICE);
  assert.equal(e.quote, null);
});

test("vendors can ask for more before quoting", async () => {
  run("UPDATE vendors SET qualify_fields = 'pax,venue' WHERE id = ?", booth);
  try {
    const { draft } = await enquire(`Photobooth for my 21st on ${day(33)} evening, 80 guests, 3 hours`);
    assert.equal(draft.purpose, "qualify");
    assert.match(draft.body, /where it'll be/);
    assert.doesNotMatch(draft.body, PRICE);
    const ok = await enquire(`Photobooth for my 21st on ${day(34)} evening at Raffles Hotel, 80 guests, 3 hours`);
    assert.equal(ok.draft.purpose, "quote");
  } finally {
    run("UPDATE vendors SET qualify_fields = '' WHERE id = ?", booth);
  }
});
