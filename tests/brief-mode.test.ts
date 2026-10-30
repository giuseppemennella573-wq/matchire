import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-brief-")), "test.db");
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.RESEND_API_KEY = "test";

const { createAccount, addItems } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const { run, get, all } = await import("../src/lib/db.ts");
const { parseEnquiry } = await import("../src/lib/heuristics.ts");
const { addDays, sgToday } = await import("../src/lib/dates.ts");

// Claude stand-in that always tries to slip a price range in, and a mailbox for Resend.
type Req = { system: string; messages: { content: string }[] };
const prompts: Req[] = [];
const emails: { to: string; subject: string; text: string }[] = [];
const MESSAGE = (json: unknown) => ({
  id: "msg_test", type: "message", role: "assistant", model: "test", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify(json) }],
});
let itemsFor = 0;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("api.resend.com")) { emails.push(JSON.parse(String(init?.body))); return Response.json({ id: "e" }); }
  if (!u.includes("api.anthropic.com")) return new Response("{}", { status: 200 });
  const req = JSON.parse(String(init?.body)) as Req;
  prompts.push(req);
  if (req.system.includes("extract booking details")) {
    const d = parseEnquiry(req.messages[0].content.split("<conversation>")[1] ?? "", E.getItems(itemsFor), sgToday());
    return Response.json(MESSAGE({ ...d, intent: "new_enquiry" }));
  }
  return Response.json(MESSAGE({ reply: "Lovely! Weddings like this usually run SGD 2,000 to 3,000.", needs_owner: false, owner_reason: null }));
}) as typeof fetch;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (n: number) => { const [, m, d] = addDays(sgToday(), n).split("-"); return `${+d} ${MON[+m - 1]}`; };
const PRICE = /SGD|S\$|\$\s?\d|\d\s?dollars|\bfrom\s+\d/i;
const H = 3600_000;

let decor: number, booth: number;
let n = 9500_0000;
const phone = () => `+65 ${++n}`;
before(() => {
  decor = createAccount({ email: "bloom@test.sg", password: "password1", name: "Lily", business: "Bloom Studio", kind: "decor" }).vendorId;
  addItems(decor, [{ kind: "package", name: "Wedding styling", pricing: "flat", price: 2500, description: "Arch, aisle and table florals", included_hours: null, extra_hour_price: null, min_pax: null, max_pax: null }]);
  run("UPDATE vendors SET pricing_mode = 'brief', brief_hours = 24, hold_hours = 48, brief_questions = 'Indoor or outdoor?' WHERE id = ?", decor);
  booth = createAccount({ email: "mixed@test.sg", password: "password1", name: "Ana", business: "Mixed Booth", kind: "photobooth", samplePrices: true }).vendorId;
});

async function enquire(vendor: number, text: string, handle = phone()) {
  itemsFor = vendor;
  prompts.length = 0;
  const { enquiryId } = E.ingest({ vendorId: vendor, channel: "whatsapp", handle, name: "Priya Shah", text });
  await E.processEnquiry(vendor, enquiryId);
  return { id: enquiryId, handle, draft: E.pendingDraft(enquiryId)!, e: E.getEnquiry(vendor, enquiryId)! };
}

test("brief mode: qualifies first, then promises a tailored quote, and never prices, even when the AI tries", async () => {
  const q = await enquire(decor, "Hi, how much for wedding flowers?");
  assert.equal(q.draft.purpose, "qualify");
  assert.doesNotMatch(q.draft.body, PRICE);

  const { draft, e } = await enquire(decor, `Wedding décor on ${day(40)} at Raffles Hotel, 120 guests, budget $5k. Rustic theme with lots of greenery.`);
  assert.equal(draft.purpose, "brief");
  assert.match(draft.body, /Bloom Studio will send you a tailored quote within 24 hours/);
  assert.match(draft.body, /pencilled in/);
  assert.match(draft.body, /Indoor or outdoor/, "the vendor's own question is asked");
  assert.doesNotMatch(draft.body, PRICE, "the AI's range was thrown out");
  assert.match(e.owner_reason!, /prices not on your list/);
  assert.equal(e.quote, null);
  const drafting = prompts.find((p) => p.system.includes("You write replies"))!;
  assert.ok(!JSON.stringify(drafting).includes("Wedding styling"), "the AI doesn't see the price list in brief mode");
});

test("sending it holds the date, briefs the vendor by email, and the planner gets no automatic follow-up", async () => {
  const { id, draft } = await enquire(decor, `Wedding décor on ${day(41)} at The Fullerton, 80 guests, budget $4k, boho style`);
  emails.length = 0;
  const t0 = Date.now();
  await E.markDraftSentManually(decor, draft.id);
  const e = E.getEnquiry(decor, id)!;
  assert.equal(e.brief_status, "waiting");
  assert.equal(e.status, "awaiting_info");
  assert.equal(e.next_followup_at, null);
  assert.ok(Math.abs(new Date(e.brief_due_at!).getTime() - (t0 + 24 * H)) < 60_000);
  const hold = get<{ expires_at: string; kind: string }>("SELECT * FROM holds WHERE enquiry_id = ? AND status = 'active'", id)!;
  assert.equal(hold.kind, "hold");
  assert.ok(Math.abs(new Date(hold.expires_at).getTime() - (t0 + 48 * H)) < 60_000, "uses the vendor's hold length");

  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ["bloom@test.sg"]);
  assert.match(emails[0].subject, /^New brief: Priya Shah/);
  for (const bit of ["Priya Shah", "Hold:      held until", "Guests:    80", "Venue:     The Fullerton", "Budget:    SGD 4,000", "Style:     boho", "In their words:", "Indoor or outdoor?"])
    assert.ok(emails[0].text.includes(bit), `brief has "${bit}"`);
  assert.ok(all("SELECT 1 FROM messages WHERE enquiry_id = ? AND direction = 'note' AND body LIKE 'Brief for your quote%'", id).length, "and in the app");

  // Past the promised time: the vendor is reminded once, the planner hears nothing.
  emails.length = 0;
  await E.tick(new Date(t0 + 25 * H).toISOString());
  await E.tick(new Date(t0 + 26 * H).toISOString());
  const reminders = emails.filter((m) => !m.subject.startsWith("Matchire backup"));
  assert.equal(reminders.length, 1);
  assert.match(reminders[0].subject, /^Quote due: Priya Shah/);
  assert.equal(E.pendingDraft(id), undefined, "nothing drafted for the planner");
  assert.match(E.getEnquiry(decor, id)!.owner_reason!, /tailored quote was due/);

  // "Quote sent": follow-ups start, and they don't make up a price.
  E.markBriefQuoted(decor, id);
  const quoted = E.getEnquiry(decor, id)!;
  assert.equal(quoted.status, "quoted");
  assert.equal(quoted.brief_status, "quoted");
  assert.ok(quoted.next_followup_at);
  await E.tick(new Date(new Date(quoted.next_followup_at!).getTime() + 60_000).toISOString());
  const nudge = E.pendingDraft(id)!;
  assert.equal(nudge.purpose, "followup");
  assert.match(nudge.body, /checking in on the quote/);
  assert.doesNotMatch(nudge.body, PRICE);
});

test("a reply the vendor writes with a price in it counts as the quote", async () => {
  const { id, handle, draft } = await enquire(decor, `Wedding décor on ${day(42)} at Capella Sentosa, 60 guests, budget $3k`);
  await E.markDraftSentManually(decor, draft.id);
  E.ingest({ vendorId: decor, channel: "whatsapp", handle, text: "Any update on the quote?" });
  await E.processEnquiry(decor, id);
  const answer = E.pendingDraft(id)!;
  assert.match(E.getEnquiry(decor, id)!.owner_reason!, /waiting for your tailored quote/);
  await E.markDraftSentManually(decor, answer.id, "Hi Priya! For 60 guests at Capella: arch and table florals, SGD 2,800 all in.");
  assert.equal(E.getEnquiry(decor, id)!.brief_status, "quoted");
  assert.equal(E.getEnquiry(decor, id)!.status, "quoted");
});

test("'Always quote manually' on one item: that item gets a brief, the rest are quoted as usual", async () => {
  const items = E.getItems(booth);
  const p360 = items.find((i) => i.name === "360 booth")!;
  run("UPDATE items SET manual_quote = 1 WHERE id = ?", p360.id);
  const manual = await enquire(booth, `360 booth for our launch on ${day(30)} evening at Marina Bay, 100 guests, 2 hours`);
  assert.equal(manual.draft.purpose, "brief");
  assert.doesNotMatch(manual.draft.body, PRICE);
  const normal = await enquire(booth, `Classic booth for my 21st on ${day(31)} evening, 80 guests, 2 hours`);
  assert.equal(normal.draft.purpose, "quote");
  const drafting = prompts.find((p) => p.system.includes("You write replies"))!;
  assert.ok(!drafting.system.includes("360 booth"), "a manually quoted item's price isn't shown to the AI");
});

test("demo accounts never email their brief", async () => {
  run("UPDATE vendors SET is_demo = 1 WHERE id = ?", decor);
  try {
    const { draft } = await enquire(decor, `Wedding décor on ${day(43)} at Raffles Hotel, 120 guests, budget $5k`);
    emails.length = 0;
    await E.markDraftSentManually(decor, draft.id);
    assert.equal(emails.length, 0);
  } finally {
    run("UPDATE vendors SET is_demo = 0 WHERE id = ?", decor);
  }
});
