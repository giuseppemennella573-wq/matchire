import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-")), "test.db");
delete process.env.ANTHROPIC_API_KEY;

const { createAccount } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const { run, get } = await import("../src/lib/db.ts");
const { addDays, sgToday } = await import("../src/lib/dates.ts");

let booth: number, venue: number;
before(() => {
  booth = createAccount({ email: "booth@test.sg", password: "password1", name: "Ana Tan", business: "Snapbox SG", kind: "photobooth", samplePrices: true }).vendorId;
  venue = createAccount({ email: "loft@test.sg", password: "password1", name: "Ben Lim", business: "The Loft", kind: "venue", samplePrices: true }).vendorId;
});

test("enquiry → quote draft → send → hold → follow-up → booked", async () => {
  const date = addDays(sgToday(), 21);
  const [y, m, d] = date.split("-");
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m - 1];
  const { enquiryId, isNew } = E.ingest({ vendorId: booth, channel: "whatsapp", handle: "+65 9123 4567", name: "Mei", text: `Hi! Photobooth for my 21st on ${+d} ${mon} evening, about 80 guests, 3 hours. Custom print frame please. Budget $900` });
  assert.ok(isNew);
  const r = await E.processEnquiry(booth, enquiryId);
  assert.equal(r.usedAI, false);
  const e = E.getEnquiry(booth, enquiryId)!;
  const q = E.parseQuote(e)!;
  assert.equal(q.total, 450 + 120 + 80);
  assert.equal(e.lead, "hot");
  const draft = E.pendingDraft(enquiryId)!;
  assert.match(draft.body, /SGD 650/);
  assert.equal(r.ownerReason, null);

  // WhatsApp isn't connected in tests: "send" keeps the draft and asks the vendor to send it by hand.
  const res = await E.sendDraft(booth, draft.id);
  assert.equal(res.status, "manual");
  assert.equal(E.pendingDraft(enquiryId)?.id, draft.id);
  assert.equal(E.getEnquiry(booth, enquiryId)!.status, "new");
  E.markDraftSentManually(booth, draft.id);
  const after = E.getEnquiry(booth, enquiryId)!;
  assert.equal(after.status, "quoted");
  assert.ok(after.first_response_at);
  assert.ok(after.next_followup_at);
  const hold = get<{ date: string; kind: string }>("SELECT * FROM holds WHERE enquiry_id = ? AND status = 'active'", enquiryId)!;
  assert.equal(hold.date, date);

  // With a 48h hold, the nudge comes at 24h, while the date is still held.
  const t = await E.tick(new Date(Date.now() + 1.1 * 86400_000).toISOString());
  assert.equal(t.followups, 1);
  assert.equal(E.pendingDraft(enquiryId)!.purpose, "followup");

  // The planner replies on the same number: it joins the conversation.
  const again = E.ingest({ vendorId: booth, channel: "whatsapp", handle: "+65 9123 4567", text: "Sounds good, let's go ahead! How do I pay the deposit?" });
  assert.equal(again.enquiryId, enquiryId);
  assert.equal(again.isNew, false);
  const r2 = await E.processEnquiry(booth, enquiryId);
  assert.ok(r2.ownerReason, "booking confirmations wait for the owner");
  assert.equal(E.pendingDraft(enquiryId)!.purpose, "confirm");
  E.markDraftSentManually(booth, E.pendingDraft(enquiryId)!.id);
  E.markBooked(booth, enquiryId);
  const won = E.getEnquiry(booth, enquiryId)!;
  assert.equal(won.status, "won");
  assert.equal(won.won_value, 650);
  assert.equal(get<{ kind: string }>("SELECT kind FROM holds WHERE enquiry_id = ?", enquiryId)!.kind, "booking");
});

test("missing details → ask for them; over capacity → owner + referral", async () => {
  const a = E.ingest({ vendorId: venue, channel: "email", email: "hr@corp.sg", text: "Hi, do you have space for a team event? Need a projector." });
  await E.processEnquiry(venue, a.enquiryId);
  const d = E.pendingDraft(a.enquiryId)!;
  assert.equal(d.purpose, "ask_info");
  assert.match(d.body, /event date/);

  run("INSERT INTO partnerships (requester_id, partner_id, status) VALUES (?, ?, 'accepted')", venue, booth);
  const b = E.ingest({ vendorId: venue, channel: "web", email: "big@party.sg", text: "Product launch for 120 people on 12 Dec evening, 4 hours" });
  const r = await E.processEnquiry(venue, b.enquiryId);
  assert.equal(E.pendingDraft(b.enquiryId)!.purpose, "over_capacity");
  assert.match(r.ownerReason!, /capacity/);

  const target = await E.referToPartner(venue, b.enquiryId, booth);
  const te = E.getEnquiry(booth, target)!;
  assert.equal(te.channel, "referral");
  assert.equal(te.referred_from, venue);
  assert.equal(E.pendingDraft(b.enquiryId)!.purpose, "referred");
  E.markDraftSentManually(venue, E.pendingDraft(b.enquiryId)!.id);
  assert.equal(E.getEnquiry(venue, b.enquiryId)!.status, "referred");
  E.markBooked(booth, target, 1000);
  const ref = get<{ status: string; fee_amount: number }>("SELECT * FROM referrals WHERE target_enquiry = ?", target)!;
  assert.equal(ref.status, "won");
  assert.equal(ref.fee_amount, 100);
});

test("blocked dates are unavailable and holds expire", async () => {
  const date = addDays(sgToday(), 30);
  E.blockDate(booth, date, "Private event");
  const v = E.getVendor(booth)!;
  assert.equal(E.availability(v, date).available, false);
  run("INSERT INTO holds (vendor_id, date, kind, expires_at) VALUES (?, ?, 'hold', ?)", booth, addDays(sgToday(), 40), new Date(Date.now() - 1000).toISOString());
  const t = await E.tick();
  assert.ok(t.expired >= 1);
});

test("vendors can't touch each other's enquiries", async () => {
  const a = E.ingest({ vendorId: booth, channel: "manual", text: "Booth for 2 hours next Friday evening" });
  assert.equal(E.getEnquiry(venue, a.enquiryId), undefined);
  await assert.rejects(() => E.processEnquiry(venue, a.enquiryId));
});

test("deleting an enquiry removes its messages, holds and referral link but not the partner's copy", async () => {
  const date = addDays(sgToday(), 50);
  const [, m, d] = date.split("-");
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m - 1];
  const { enquiryId } = E.ingest({ vendorId: venue, channel: "web", email: "del@test.sg", text: `Birthday on ${+d} ${mon} evening, 30 guests, 4 hours` });
  await E.processEnquiry(venue, enquiryId);
  E.markDraftSentManually(venue, E.pendingDraft(enquiryId)!.id);
  assert.ok(get("SELECT 1 FROM holds WHERE enquiry_id = ?", enquiryId));
  const target = await E.referToPartner(venue, enquiryId, booth);
  E.deleteEnquiry(venue, enquiryId);
  assert.equal(E.getEnquiry(venue, enquiryId), undefined);
  assert.equal(get("SELECT 1 FROM messages WHERE enquiry_id = ?", enquiryId), undefined);
  assert.equal(get("SELECT 1 FROM holds WHERE enquiry_id = ?", enquiryId), undefined);
  assert.equal(get("SELECT 1 FROM referrals WHERE source_enquiry = ?", enquiryId), undefined);
  assert.ok(E.getEnquiry(booth, target), "partner keeps the referred copy");
  assert.throws(() => E.deleteEnquiry(booth, enquiryId));
});
