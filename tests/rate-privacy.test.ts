import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A vendor's prices are private to their account. Partners only ever see a
// single "from" price, and only if that vendor opts in.

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-")), "test.db");
process.env.ANTHROPIC_API_KEY = "test-key";

const { createAccount } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const { run, all } = await import("../src/lib/db.ts");
const { parseEnquiry } = await import("../src/lib/heuristics.ts");
const { addDays, sgToday } = await import("../src/lib/dates.ts");

// Claude stand-in: records every prompt and answers like the real API would.
type Req = { system: string; messages: { content: string }[] };
const prompts: Req[] = [];
const MESSAGE = (json: unknown) => ({
  id: "msg_test", type: "message", role: "assistant", model: "test", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify(json) }],
});
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  if (!String(url).includes("api.anthropic.com")) return new Response("{}", { status: 200 });
  const req = JSON.parse(String(init?.body)) as Req;
  prompts.push(req);
  const convo = req.messages[0].content;
  if (req.system.includes("extract booking details")) {
    // Read the conversation with the built-in parser so the flow continues as it would with Claude.
    const d = parseEnquiry(convo, E.getItems(req.system.includes("Snapbox SG") ? booth : kitchen), sgToday());
    return Response.json(MESSAGE({ ...d, intent: "new_enquiry" }));
  }
  return Response.json(MESSAGE({ reply: "Thanks! Here's your quote.", needs_owner: false, owner_reason: null }));
}) as typeof fetch;

const CATERER_ITEMS = ["Buffet", "Canapés", "Bento sets", "Delivery & setup", "Service staff"];
const BOOTH_ITEMS = ["Classic booth", "360 booth", "Custom print frame", "Guestbook album"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let booth: number, kitchen: number;
before(() => {
  booth = createAccount({ email: "booth@test.sg", password: "password1", name: "Ana", business: "Snapbox SG", kind: "photobooth", samplePrices: true }).vendorId;
  kitchen = createAccount({ email: "kitchen@test.sg", password: "password1", name: "Raj", business: "Rempah Kitchen", kind: "caterer", samplePrices: true }).vendorId;
  run("INSERT INTO partnerships (requester_id, partner_id, status) VALUES (?, ?, 'accepted')", booth, kitchen);
});

async function weddingEnquiry(phone: string, inDays: number) {
  const [, m, d] = addDays(sgToday(), inDays).split("-");
  const { enquiryId } = E.ingest({ vendorId: booth, channel: "whatsapp", handle: phone, name: "Mei", text: `Hi! Photobooth for our wedding on ${+d} ${MON[+m - 1]} evening, about 80 guests, 3 hours.` });
  prompts.length = 0;
  await E.processEnquiry(booth, enquiryId);
  const draftPrompt = prompts.find((p) => p.system.includes("You write replies"))!;
  assert.ok(draftPrompt, "the reply was drafted by the AI");
  const facts = JSON.parse(draftPrompt.messages[0].content.split("Facts (authoritative):\n")[1]);
  return { enquiryId, facts, all: JSON.stringify(prompts) };
}

test("new and existing accounts don't share their starting price", () => {
  const v = E.getVendor(kitchen)!;
  assert.equal(v.share_from_price, 0);
  assert.equal(E.sharedFromPrice(v), null);
  assert.deepEqual(E.partnerView(v), { view: { name: "Rempah Kitchen", category: "catering", from_price: null }, price: null });
});

test("sharing off: partner suggestions carry name and category only, and the AI never sees the partner's prices", async () => {
  const { facts, all } = await weddingEnquiry("+65 9100 0001", 30);
  assert.deepEqual(facts.partnerSuggestions, [{ name: "Rempah Kitchen", category: "catering", from_price: null }]);
  for (const name of CATERER_ITEMS) assert.ok(!all.includes(name), `AI prompt mentions the partner's "${name}"`);
  assert.ok(!all.includes("16/pax") && !all.includes("SGD 16"), "no partner price in any prompt");

  const body = E.templateDraft(E.getVendor(booth)!, { ...facts, quote: null });
  assert.match(body, /Our partner Rempah Kitchen \(catering\) can quote you directly\./);
  assert.doesNotMatch(body, /Rempah Kitchen[^.]*SGD/);
});

test("sharing on: exactly one starting price, never the price list", async () => {
  run("UPDATE vendors SET share_from_price = 1 WHERE id = ?", kitchen);
  const { facts, all } = await weddingEnquiry("+65 9100 0002", 31);
  assert.deepEqual(facts.partnerSuggestions, [{ name: "Rempah Kitchen", category: "catering", from_price: "SGD 16/pax" }]);
  for (const name of CATERER_ITEMS) assert.ok(!all.includes(name), `AI prompt mentions the partner's "${name}"`);
  for (const other of ["SGD 32", "SGD 28", "SGD 35"]) assert.ok(!all.includes(other), `AI prompt includes ${other}`);

  const body = E.templateDraft(E.getVendor(booth)!, { ...facts, quote: null });
  assert.match(body, /Our partner Rempah Kitchen \(catering\) starts from SGD 16\/pax and can quote you directly\./);
  run("UPDATE vendors SET share_from_price = 0 WHERE id = ?", kitchen);
});

test("referral: the partner gets the planner's messages, never the referrer's replies or prices", async () => {
  const { enquiryId } = await weddingEnquiry("+65 9100 0003", 32);
  const quote = E.pendingDraft(enquiryId)!;
  E.markDraftSentManually(booth, quote.id, "Hi Mei! Classic booth SGD 450, 2 hours. Custom print frame SGD 80.");

  prompts.length = 0;
  const targetId = await E.referToPartner(booth, enquiryId, kitchen);
  const copied = all<{ direction: string; body: string }>("SELECT direction, body FROM messages WHERE enquiry_id = ? AND status != 'draft'", targetId);
  assert.ok(copied.length > 0);
  assert.ok(copied.every((m) => m.direction === "in" || m.direction === "note"), "only the planner's messages are copied");
  const text = copied.map((m) => m.body).join("\n");
  assert.doesNotMatch(text, /SGD 450|SGD 80/);
  assert.match(text, /Referred by Snapbox SG/);

  // The partner's own AI calls only ever see the partner's price list.
  assert.ok(prompts.some((p) => p.system.includes("Rempah Kitchen")), "the partner's reply was drafted");
  const partnerPrompts = JSON.stringify(prompts);
  for (const name of BOOTH_ITEMS) assert.ok(!partnerPrompts.includes(name), `partner's AI prompt mentions the referrer's "${name}"`);
});
