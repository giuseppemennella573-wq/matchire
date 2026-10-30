import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// How a planner's reply is read once they have a quote: only clear refusals close
// the enquiry; hesitating, "no thanks" and "too expensive" keep it open.

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-replies-")), "test.db");
delete process.env.ANTHROPIC_API_KEY;

const { createAccount, addItems } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const { detectIntent, parseEnquiry } = await import("../src/lib/heuristics.ts");
const { run, get } = await import("../src/lib/db.ts");
const { addDays, dayOfWeek, sgToday } = await import("../src/lib/dates.ts");

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const written = (iso: string) => `${+iso.slice(8)} ${MON[+iso.slice(5, 7) - 1]}`;
const read = (text: string) => parseEnquiry(text, [], sgToday());

let booth: number, sat: string;
let n = 9900_0000;
before(() => {
  booth = createAccount({ email: "rep@test.sg", password: "password1", name: "Mel", business: "Snap & Smile", kind: "photobooth" }).vendorId;
  const base = { kind: "package" as const, pricing: "flat" as const, description: "", min_pax: null, max_pax: null };
  addItems(booth, [
    { ...base, name: "Classic Booth 3h", price: 850, included_hours: 3, extra_hour_price: 180 },
    { ...base, name: "Classic Booth 4h", price: 1050, included_hours: 4, extra_hour_price: 180 },
    { ...base, kind: "addon", name: "Guestbook album", price: 150, included_hours: null, extra_hour_price: null },
  ]);
  run("UPDATE vendors SET offpeak_discount = 10, auto_send = 1 WHERE id = ?", booth);
  sat = addDays(sgToday(), 30);
  while (dayOfWeek(sat) !== 6) sat = addDays(sat, 1);
});

/** A quoted enquiry (sent, date held), then the planner's reply. */
async function quotedThenReply(reply: string) {
  const handle = `+65 ${++n}`;
  const date = addDays(sat, 7 * (n % 20)); // a free Saturday each time
  const { enquiryId: id } = E.ingest({ vendorId: booth, channel: "manual", handle, text: `Wedding on ${written(date)} evening, 120 guests, 4 hours with the guestbook` });
  run("UPDATE vendors SET auto_send = 0 WHERE id = ?", booth);
  await E.processEnquiry(booth, id);
  E.markDraftSentManually(booth, E.pendingDraft(id)!.id);
  run("UPDATE vendors SET auto_send = 1 WHERE id = ?", booth);
  assert.equal(E.getEnquiry(booth, id)!.status, "quoted");
  E.ingest({ vendorId: booth, channel: "manual", handle, text: reply });
  const r = await E.processEnquiry(booth, id);
  const e = E.getEnquiry(booth, id)!;
  const sent = get<{ purpose: string; body: string }>("SELECT purpose, body FROM messages WHERE enquiry_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1", id)!;
  return { id, r, e, d: E.parseDetails(e), reply: sent, hold: get<{ status: string }>("SELECT status FROM holds WHERE enquiry_id = ? ORDER BY id DESC LIMIT 1", id)!.status };
}

test("hesitating, with no details and no question, reads as undecided", () => {
  for (const t of ["not sure yet", "Maybe", "let me check with my partner", "Let me check with my boss first", "need to discuss with my wife",
    "still deciding", "will get back to you", "I'll get back to you next week", "haven't decided", "thinking about it", "let me think"]) {
    assert.equal(read(t).intent, "undecided", t);
    assert.equal(read(t).undecided, true, t);
  }
});

test("hesitating with details is details; with a question it's a question that's still undecided", () => {
  const d = read("maybe around 80 guests");
  assert.notEqual(d.intent, "undecided");
  assert.equal(d.pax, 80);
  assert.equal(d.undecided, false);
  const q = read("not sure yet, does it include props?");
  assert.equal(q.intent, "question");
  assert.equal(q.undecided, true);
});

test("only clear refusals decline; weaker ones are for the vendor; '?' never declines", () => {
  for (const t of ["we went with someone else", "We booked another vendor", "found another photobooth, thanks", "no longer need it", "not needed anymore", "Not interested, thanks", "we decided not to have a booth"])
    assert.equal(detectIntent(t.toLowerCase()), "declines", t);
  for (const t of ["no thanks on the 4h", "No thank you", "cancel the backdrop", "we cancelled the party", "we'll pass"])
    assert.equal(detectIntent(t.toLowerCase()), "soft_decline", t);
  for (const t of ["cancel the backdrop?", "did you go with someone else?", "not interested in the album, is the 3h ok?"])
    assert.notEqual(detectIntent(t.toLowerCase()), "declines", t);
  for (const t of ["too expensive", "That's over our budget", "a bit too much for us", "anything cheaper?"])
    assert.equal(detectIntent(t.toLowerCase()), "price_concern", t);
});

test("'maybe 80 guests on 12 Dec' quotes normally", async () => {
  const { enquiryId } = E.ingest({ vendorId: booth, channel: "manual", handle: `+65 ${++n}`, text: "maybe 80 guests on 12 Dec, 3 hours in the evening" });
  await E.processEnquiry(booth, enquiryId);
  const e = E.getEnquiry(booth, enquiryId)!;
  assert.equal(get<{ purpose: string }>("SELECT purpose FROM messages WHERE enquiry_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1", enquiryId)!.purpose, "quote");
  assert.equal(E.parseDetails(e).undecided, false);
  assert.ok(E.parseQuote(e)!.total > 0);
});

test("'not sure yet' after a quote: stays Quoted, keeps the hold, Undecided, a no-rush reply, follow-ups restart", async () => {
  const t0 = Date.now();
  const { e, d, reply, hold, r } = await quotedThenReply("not sure yet");
  assert.equal(e.status, "quoted");
  assert.equal(hold, "active");
  assert.equal(d.undecided, true);
  assert.equal(reply.purpose, "undecided");
  assert.match(reply.body, /No rush at all/);
  assert.equal(r.ownerReason, null, "a routine reply: auto-send may send it (here there's no channel to send on)");
  assert.ok(e.next_followup_at && new Date(e.next_followup_at).getTime() > t0, "the follow-up is scheduled again");
});

test("'not sure yet, does it include props?': the question is answered and it's still Undecided", async () => {
  const { e, d, reply } = await quotedThenReply("not sure yet, does it include props?");
  assert.equal(reply.purpose, "answer");
  assert.equal(d.undecided, true);
  assert.equal(e.status, "quoted");
  assert.ok(e.next_followup_at, "follow-ups restart");
});

test("'no thanks on the 4h': stays Quoted with the hold, and waits for the vendor", async () => {
  const { e, reply, hold, r } = await quotedThenReply("no thanks on the 4h");
  assert.equal(e.status, "quoted");
  assert.equal(hold, "active");
  assert.equal(r.autoSent, false);
  assert.equal(E.pendingDraft(e.id)!.purpose, "answer");
  assert.match(e.owner_reason!, /whole booking or one item/);
  void reply;
});

test("'too expensive': Price concern, real cheaper options only, and it waits for approval", async () => {
  const { e, d, r } = await quotedThenReply("too expensive");
  assert.equal(d.intent, "price_concern");
  assert.equal(e.status, "quoted");
  assert.equal(r.autoSent, false, "never auto-sent");
  assert.match(e.owner_reason!, /Price concern/);
  const body = E.pendingDraft(e.id)!.body;
  assert.equal(E.pendingDraft(e.id)!.purpose, "price_concern");
  assert.match(body, /If it helps, Classic Booth 3h with the guestbook album is SGD 1,000\./, "the smaller package, with the add-on");
  assert.match(body, /weekday daytime slot, like \w{3} \d+ \w{3} afternoon, the same booking is SGD 1,095 with our 10% off-peak rate/, "4h 1050 less 10%, plus 150");
});

test("'we went with someone else' closes it as lost and releases the date", async () => {
  const { e, hold } = await quotedThenReply("we went with someone else");
  assert.equal(e.status, "lost");
  assert.equal(hold, "released");
});
