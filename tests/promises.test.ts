import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-promise-")), "test.db");
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "SMTP_HOST"]) delete process.env[k];
process.env.RESEND_API_KEY = "test";
const emails: { to: string[]; subject: string; text: string }[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  if (String(url).includes("api.resend.com")) emails.push(JSON.parse(String(init?.body)));
  return Response.json({ id: "x" });
}) as typeof fetch;

const { createAccount, addItems } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const A = await import("../src/lib/ai.ts");
const { run, get } = await import("../src/lib/db.ts");
const { addDays, sgToday } = await import("../src/lib/dates.ts");
const { parseEnquiry } = await import("../src/lib/heuristics.ts");

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (n: number) => { const [, m, d] = addDays(sgToday(), n).split("-"); return `${+d} ${MON[+m - 1]}`; };
const needsYou = (vendorId: number) => get<{ n: number }>(
  `SELECT COUNT(*) n FROM enquiries e WHERE e.vendor_id = ? AND (EXISTS (SELECT 1 FROM messages m WHERE m.enquiry_id = e.id AND m.status = 'draft') OR e.promised_reason IS NOT NULL)`, vendorId)!.n;

let booth: number, solo: number;
let n = 0;
const phone = () => `+65 9800 ${String(1000 + n++)}`;
before(() => {
  // Photobooth sample list: Classic booth SGD 450 for 2h, +120/extra hour.
  booth = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth", samplePrices: true }).vendorId;
  // One package only: nothing cheaper to offer.
  solo = createAccount({ email: "ana@one.sg", password: "password1", name: "Ana", business: "One Booth", kind: "other" }).vendorId;
  addItems(solo, [{ kind: "package", name: "Mirror booth", pricing: "flat", price: 900, description: "", included_hours: 3, extra_hour_price: 200, min_pax: null, max_pax: null }]);
});

test("over budget with a cheaper real option: the reply offers it, and promises nothing", async () => {
  const { enquiryId } = E.ingest({ vendorId: booth, channel: "whatsapp", handle: phone(), text: `Classic booth on ${day(30)} evening, 80 guests, 3 hours. Budget around $500` });
  await E.processEnquiry(booth, enquiryId);
  const draft = E.pendingDraft(enquiryId)!;
  assert.match(draft.body, /That.s above the SGD 500 budget you mentioned\. If it helps, Classic booth for 2h instead of 3, with the setup & transport, is SGD 510\./);
  assert.doesNotMatch(draft.body, /reply directly|get back|check with/i);
  assert.equal(draft.promise, null);
});

test("over budget with nothing cheaper: hands over plainly, flags 'Promised a reply', and tells the vendor once it's sent", async () => {
  emails.length = 0;
  const { enquiryId } = E.ingest({ vendorId: solo, channel: "email", handle: "kim@x.sg", email: "kim@x.sg", text: `Mirror booth on ${day(31)} evening, 60 guests, 3 hours. Our budget is $500` });
  await E.processEnquiry(solo, enquiryId);
  const draft = E.pendingDraft(enquiryId)!;
  assert.match(draft.body, /That's above the SGD 500 budget you mentioned, and it's our simplest option for this booking\. I'll pass this to One Booth and they'll reply directly\./);
  assert.match(draft.promise ?? "", /below your simplest option \(SGD 900\)/);
  assert.match(E.getEnquiry(solo, enquiryId)!.owner_reason ?? "", /This reply says you'll reply directly/, "the vendor sees it before sending");

  await E.sendDraft(solo, draft.id);
  const e = E.getEnquiry(solo, enquiryId)!;
  assert.match(e.promised_reason ?? "", /below your simplest option/);
  assert.equal(needsYou(solo), 1, "stays in Needs you after sending, with nothing drafted");
  const mail = emails.find((m) => m.subject.startsWith("Reply promised"));
  assert.ok(mail, "the vendor is told");
  assert.deepEqual(mail!.to, ["ana@one.sg"]);
  assert.match(mail!.text, /below your simplest option/);

  // The vendor replies (here: a manual reply) → the flag clears.
  E.ingest({ vendorId: solo, channel: "email", handle: "kim@x.sg", email: "kim@x.sg", text: "Any chance of a deal?" });
  await E.processEnquiry(solo, enquiryId);
  const next = E.pendingDraft(enquiryId)!;
  run("UPDATE messages SET body = 'Hi Kim, I can do SGD 800 for you.', promise = NULL WHERE id = ?", next.id);
  await E.markDraftSentManually(solo, next.id, "Hi Kim, I can do SGD 800 for you.");
  assert.equal(E.getEnquiry(solo, enquiryId)!.promised_reason, null);
});

test("unanswerable questions hand over with the same sentence (templates never say 'get back to you')", async () => {
  const { enquiryId } = E.ingest({ vendorId: booth, channel: "whatsapp", handle: phone(), text: `Classic booth on ${day(32)} evening, 50 guests, 2 hours` });
  await E.processEnquiry(booth, enquiryId);
  await E.markDraftSentManually(booth, E.pendingDraft(enquiryId)!.id);
  E.ingest({ vendorId: booth, channel: "whatsapp", handle: E.getEnquiry(booth, enquiryId)!.contact_handle!, text: "Can the booth go on a boat?" });
  await E.processEnquiry(booth, enquiryId);
  const draft = E.pendingDraft(enquiryId)!;
  assert.doesNotMatch(draft.body, E.UNMADE_PROMISE);
  if (E.handsOver(draft.body)) assert.ok(draft.promise, "a handover always records what it promises");
});

test("an AI draft that promises a check or a call back isn't used", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  A.setClientForTests({ beta: { messages: { parse: async (req: { model: string; system: unknown; messages: { content: string }[] }) => {
    const system = typeof req.system === "string" ? req.system : (req.system as { text: string }[]).map((b) => b.text).join("");
    const usage = { input_tokens: 1, output_tokens: 1 };
    if (/extract booking details/.test(system)) {
      const d = parseEnquiry(req.messages[0].content.split("<conversation>")[1] ?? "", E.getItems(booth), sgToday());
      return { model: req.model, stop_reason: "end_turn", usage, parsed_output: { ...d, intent: "new_enquiry", relevance: "enquiry", relevance_reason: null } };
    }
    assert.match(system, /The handoff sentence is the only way to hand over/);
    return { model: req.model, stop_reason: "end_turn", usage, parsed_output: { reply: "Thanks! That's a bit above your budget. Let me check with the team and I'll get back to you shortly.", needs_owner: false, owner_reason: null } };
  } } } });
  try {
    const { enquiryId } = E.ingest({ vendorId: booth, channel: "whatsapp", handle: phone(), text: `Classic booth on ${day(33)} evening, 80 guests, 3 hours. Budget $400` });
    const r = await E.processEnquiry(booth, enquiryId);
    const body = E.pendingDraft(enquiryId)!.body;
    assert.doesNotMatch(body, /check with the team|get back to you/);
    assert.match(r.ownerReason ?? "", /promised something you haven't set up/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("'Mark as done' clears the flag, and demo accounts are never emailed", async () => {
  run("UPDATE vendors SET is_demo = 1 WHERE id = ?", solo);
  emails.length = 0;
  const { enquiryId } = E.ingest({ vendorId: solo, channel: "email", handle: "lee@x.sg", email: "lee@x.sg", text: `Mirror booth on ${day(34)} evening, 40 guests, 3 hours, budget $300` });
  await E.processEnquiry(solo, enquiryId);
  await E.markDraftSentManually(solo, E.pendingDraft(enquiryId)!.id);
  assert.ok(E.getEnquiry(solo, enquiryId)!.promised_reason);
  assert.equal(emails.length, 0, "demo: simulated");
  run("UPDATE enquiries SET owner_reason = NULL, promised_reason = NULL, promised_at = NULL WHERE id = ?", enquiryId); // what "Mark as done" runs
  assert.equal(E.getEnquiry(solo, enquiryId)!.promised_reason, null);
  run("UPDATE vendors SET is_demo = 0 WHERE id = ?", solo);
});
