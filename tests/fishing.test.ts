import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-fish-")), "test.db");
delete process.env.ANTHROPIC_API_KEY;

const { createAccount } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const { fishingSignal } = await import("../src/lib/fishing.ts");
const { run, all, get } = await import("../src/lib/db.ts");
const { addDays, sgToday } = await import("../src/lib/dates.ts");
const { EMPTY_DETAILS } = await import("../src/lib/types.ts");

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (n: number) => { const [, m, d] = addDays(sgToday(), n).split("-"); return `${+d} ${MON[+m - 1]}`; };
const ACCUSING = /fish|competitor|suspicious|bargain|spam/i;

let booth: number;
let n = 9400_0000;
const phone = () => `+65 ${++n}`;
before(() => {
  booth = createAccount({ email: "f@test.sg", password: "password1", name: "Ana", business: "Snapbox SG", kind: "photobooth", samplePrices: true }).vendorId;
  run("UPDATE vendors SET auto_send = 1 WHERE id = ?", booth); // so we can see it's held back
});

/** Planner message → draft → we "send" it by hand, like the vendor would. */
async function say(handle: string, text: string, enquiryId?: number) {
  const id = enquiryId ?? E.ingest({ vendorId: booth, channel: "whatsapp", handle, text }).enquiryId;
  if (enquiryId) E.ingest({ vendorId: booth, channel: "whatsapp", handle, text });
  const r = await E.processEnquiry(booth, id);
  const draft = E.pendingDraft(id);
  if (draft) E.markDraftSentManually(booth, draft.id);
  return { id, r, draft, e: E.getEnquiry(booth, id)! };
}

test("the signals, one by one", () => {
  const d = { ...EMPTY_DETAILS };
  const base = { inbound: ["hi"], repliesAfterDateAsk: 0, details: d, firstDetails: d, recentDates: [] as (string | null)[] };
  assert.equal(fishingSignal(base), null);
  assert.equal(fishingSignal({ ...base, inbound: ["how much?", "what are your rates"] })?.signal, "price_asks");
  assert.equal(fishingSignal({ ...base, inbound: ["how much?", "what are your rates"], details: { ...d, event_date: "2026-12-12" } }), null, "a date answers it");
  assert.equal(fishingSignal({ ...base, inbound: ["hi", "maybe", "not sure yet"], repliesAfterDateAsk: 2 })?.signal, "dodged_date");
  assert.equal(fishingSignal({ ...base, inbound: ["Can you send your full package list?"] })?.signal, "full_list");
  assert.equal(fishingSignal({ ...base, inbound: ["Send me all your prices please"] })?.signal, "full_list");
  assert.equal(fishingSignal({ ...base, inbound: ["Wedding on 12 Dec, 100 pax. Can you send your rate card?"], firstDetails: { ...d, event_date: "2026-12-12", pax: 100 } }), null, "a real event with a rate-card ask is fine");
  assert.equal(fishingSignal({ ...base, recentDates: [null, "2026-12-01", "2026-12-08"] })?.signal, "repeat_contact");
  assert.equal(fishingSignal({ ...base, recentDates: ["2026-12-01", "2026-12-01", "2026-12-01"] }), null, "same date three times is someone persistent, not fishing");
  assert.equal(fishingSignal({ ...base, recentDates: [null, null] }), null, "two isn't three");
});

test("asking for prices twice without a date: flagged, logged, and no automatic reply", async () => {
  const h = phone();
  const first = await say(h, "hi how much for photobooth");
  assert.equal(first.e.fishing_reason, null);
  const second = await say(h, "just tell me your prices", first.id);
  assert.match(second.e.fishing_reason!, /asked for prices 2 times without giving a date/);
  assert.equal(second.r.autoSent, false, "auto-send is on, but it waits for the vendor");
  assert.match(second.r.ownerReason!, /Possible price-fishing/);
  assert.doesNotMatch(second.draft!.body, ACCUSING, "the planner is never accused");
  assert.equal(get<{ n: number }>("SELECT COUNT(*) n FROM enquiry_flags WHERE enquiry_id = ? AND signal = 'price_asks'", first.id)!.n, 1);
});

test("dodging the date twice is flagged", async () => {
  const h = phone();
  const a = await say(h, "Hi, interested in a photobooth for a party, about 50 guests");
  await say(h, "hmm let me check with my family first", a.id);
  const c = await say(h, "still deciding, what's it like usually?", a.id);
  assert.match(c.e.fishing_reason!, /replied twice without giving the event date/);
});

test("the full price list in the first message, with no event details, is flagged", async () => {
  const { e, r } = await say(phone(), "Hi, can you send me your full price list?");
  assert.match(e.fishing_reason!, /full price list/);
  assert.equal(r.autoSent, false);
});

test("the same contact sending 3+ enquiries in 30 days with different dates is flagged", async () => {
  const h = phone();
  for (const [i, days] of [[0, 20], [1, 27]] as const) {
    const { id } = await say(h, `Photobooth for my party on ${day(days)} evening, 40 guests, 2 hours`);
    E.markLost(booth, id); // closed, so the next message starts a new enquiry
    assert.equal(E.getEnquiry(booth, id)!.fishing_reason, null, `enquiry ${i + 1} isn't flagged`);
  }
  const third = await say(h, `Photobooth on ${day(34)} evening, 40 guests, 2 hours?`);
  assert.match(third.e.fishing_reason!, /3 enquiries from this contact in 30 days/);
});

test("flagged: a priced follow-up isn't sent on its own; clearing the flag is one click and sticks", async () => {
  const h = phone();
  const a = await say(h, "Hi, can you send me your full price list?");
  assert.ok(a.e.fishing_reason);
  // The vendor chooses to price it anyway and sends it by hand; the follow-up later stays a draft.
  await E.sendPriceAnyway(booth, a.id);
  E.markDraftSentManually(booth, E.pendingDraft(a.id)!.id);
  run("UPDATE enquiries SET next_followup_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), a.id);
  await E.tick();
  const followup = E.pendingDraft(a.id)!;
  assert.equal(followup.purpose, "followup");
  assert.equal(followup.status, "draft", "not sent automatically");
  assert.match(E.getEnquiry(booth, a.id)!.owner_reason!, /price-fishing/);

  E.clearFishingFlag(booth, a.id);
  const cleared = E.getEnquiry(booth, a.id)!;
  assert.equal(cleared.fishing_reason, null);
  assert.equal(cleared.fishing_cleared, 1);
  await say(h, "what are your prices again?", a.id);
  assert.equal(E.getEnquiry(booth, a.id)!.fishing_reason, null, "not raised again once cleared");
  assert.ok(all("SELECT 1 FROM enquiry_flags WHERE enquiry_id = ? AND cleared_at IS NOT NULL", a.id).length, "the log keeps it, marked cleared");
  assert.ok(E.countFishingFlags(booth) >= 5);
});
