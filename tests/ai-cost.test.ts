import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-cost-")), "test.db");
process.env.ANTHROPIC_API_KEY = "test-key";
for (const k of ["MATCHIRE_MODEL", "MATCHIRE_EXTRACT_MODEL", "MATCHIRE_PROMPT_CACHE", "SMTP_HOST", "RESEND_API_KEY"]) delete process.env[k];

const { createAccount } = await import("../src/lib/accounts.ts");
const A = await import("../src/lib/ai.ts");
const E = await import("../src/lib/engine.ts");
const { get } = await import("../src/lib/db.ts");
const { EMPTY_DETAILS } = await import("../src/lib/types.ts");

type Req = { model: string; system: unknown; messages: { content: unknown }[]; fallbacks?: unknown; betas?: unknown };
const calls: Req[] = [];
let reply: (req: Req) => unknown;
A.setClientForTests({ beta: { messages: { parse: async (req: Req) => { calls.push(req); return reply(req); } } } });

const DETAILS = { ...EMPTY_DETAILS, contact_name: null, date_text: null, date_is_approximate: false, start_time: null, style: null, owner_reason: null, summary: null };
const ok = (parsed: unknown) => (req: Req) => ({ model: req.model, stop_reason: "end_turn", parsed_output: parsed, usage: { input_tokens: 10, output_tokens: 5 } });

let vendorId: number;
before(() => {
  vendorId = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth", samplePrices: true }).vendorId;
});
afterEach(() => {
  calls.length = 0;
  delete process.env.MATCHIRE_EXTRACT_MODEL;
  delete process.env.MATCHIRE_PROMPT_CACHE;
});

const extract = () => A.aiExtract({ vendor: E.getVendor(vendorId)!, items: E.getItems(vendorId), messages: [{ direction: "in", body: "Hi, wedding next Sat for 100 pax", created_at: "2026-11-02T01:00:00Z" }], previous: null, today: "2026-11-02" });

test("caching marks only the stable system prompt, never the conversation; today's date sits with the conversation", async () => {
  reply = ok(DETAILS);
  await extract();
  const req = calls[0];
  assert.ok(Array.isArray(req.system));
  const [block] = req.system as { text: string; cache_control?: unknown }[];
  assert.deepEqual(block.cache_control, { type: "ephemeral" });
  assert.ok(!block.text.includes("2026-11-02"), "no date in the cached part, so it stays the same all week");
  assert.match(JSON.stringify(req.messages), /Today is 2026-11-02/);
  assert.ok(!JSON.stringify(req.messages).includes("cache_control"), "the conversation is never cached");

  process.env.MATCHIRE_PROMPT_CACHE = "off";
  await extract();
  assert.equal(typeof calls[1].system, "string", "MATCHIRE_PROMPT_CACHE=off sends a plain system prompt");
});

test("reading enquiries uses MATCHIRE_EXTRACT_MODEL; drafting stays on the main model", async () => {
  process.env.MATCHIRE_EXTRACT_MODEL = "claude-haiku-5-5";
  reply = ok(DETAILS);
  await extract();
  assert.equal(calls[0].model, "claude-haiku-5-5");
  assert.equal(calls[0].fallbacks, undefined, "Haiku doesn't take the server-side fallback");
  reply = ok({ reply: "Hi!", needs_owner: false, owner_reason: null });
  await A.aiDraft({ vendor: E.getVendor(vendorId)!, items: [], messages: [], facts: { purpose: "ask_info", details: EMPTY_DETAILS, quote: null, available: null, missing: [], holdHours: null, partnerSuggestions: [], referredTo: null, depositNote: "" } });
  assert.equal(calls[1].model, "claude-opus-5-5");
  assert.equal(calls[1].fallbacks, "default", "the main model keeps the server-side refusal fallback");
});

test("a refusal on the cheaper reading model is retried on the main model", async () => {
  process.env.MATCHIRE_EXTRACT_MODEL = "claude-haiku-5-5";
  reply = (req) => req.model === "claude-haiku-5-5"
    ? { model: req.model, stop_reason: "refusal", parsed_output: null, usage: { input_tokens: 10, output_tokens: 0 } }
    : ok({ ...DETAILS, pax: 100 })(req);
  const d = await extract();
  assert.deepEqual(calls.map((c) => c.model), ["claude-haiku-5-5", "claude-opus-5-5"]);
  assert.equal(d.pax, 100);
});

test("a failed AI call still falls back to rules mode", async () => {
  reply = () => { throw new Error("overloaded"); };
  const { enquiryId } = E.ingest({ vendorId, channel: "whatsapp", text: "Hi! Birthday party on 12 Dec for 80 guests, 3 hours. How much?", name: "Zoe", handle: "+65 9555 0002" });
  const r = await E.processEnquiry(vendorId, enquiryId);
  assert.equal(r.usedAI, false);
  const e = E.getEnquiry(vendorId, enquiryId)!;
  assert.match(e.owner_reason ?? "", /AI unavailable/);
  assert.ok(get("SELECT 1 FROM messages WHERE enquiry_id = ? AND status = 'draft'", enquiryId), "a reply is still drafted, from the template");
  assert.equal(E.parseDetails(e).pax, 80, "the rules-based reader still read the enquiry");
});
