import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-ai-")), "test.db");
process.env.ANTHROPIC_API_KEY = "test-key";
delete process.env.MATCHIRE_MODEL;

const { createAccount } = await import("../src/lib/accounts.ts");
const A = await import("../src/lib/ai.ts");
const U = await import("../src/lib/ai-usage.ts");
const { all, run } = await import("../src/lib/db.ts");
const E = await import("../src/lib/engine.ts");
const { EMPTY_DETAILS } = await import("../src/lib/types.ts");

let vendorId: number, demoId: number;
let next: () => Promise<unknown>;
A.setClientForTests({ beta: { messages: { parse: () => next() } } });

const SECRET = "my rate is SGD 777 for the Grand Ballroom";
const ok = (parsed: unknown, usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, model = "claude-opus-5-5") =>
  async () => ({ model, stop_reason: "end_turn", parsed_output: parsed, usage });

before(() => {
  vendorId = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth" }).vendorId;
  demoId = createAccount({ email: "demo@x.sg", password: "password1", name: "Demo", business: "Demo Co", kind: "photobooth" }).vendorId;
  run("UPDATE vendors SET is_demo = 1 WHERE id = ?", demoId);
});

const extractArgs = (vid: number) => ({
  vendor: E.getVendor(vid)!, items: [], messages: [{ direction: "in" as const, body: SECRET, created_at: "2026-11-01T00:00:00Z" }], previous: null, today: "2026-11-02", enquiryId: undefined,
});

test("the cost maths is right for a known example", () => {
  // 1M in + 1M out on Opus 5.5 = $4 + $20; cache 1M write + 1M read = $5 + $0.20
  assert.equal(U.costUsd("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 24);
  assert.equal(U.costUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }), 5.2);
  assert.ok(Math.abs(U.costUsd("claude-haiku-5-5", { input_tokens: 2000, output_tokens: 400 })! - 0.0004) < 1e-12);
  assert.equal(U.costUsd("some-unknown-model", { input_tokens: 10, output_tokens: 10 }), null);
});

test("a successful call records tokens, model and purpose, and no message text", async () => {
  next = ok({ ...EMPTY_DETAILS, contact_name: null, date_text: null, date_is_approximate: false, start_time: null, style: null, owner_reason: null, summary: null });
  await A.aiExtract(extractArgs(vendorId));
  const rows = all<Record<string, unknown>>("SELECT * FROM ai_usage");
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.purpose, "extract");
  assert.equal(r.model, "claude-opus-5-5");
  assert.equal(r.vendor_id, vendorId);
  assert.equal(r.input_tokens, 1000);
  assert.equal(r.output_tokens, 200);
  assert.equal(r.ok, 1);
  assert.ok(Math.abs((r.cost_usd as number) - 0.008) < 1e-12, "1000 in × $4/M + 200 out × $20/M");
  assert.ok(!JSON.stringify(rows).includes("777") && !JSON.stringify(rows).includes("Ballroom"), "no content stored");
});

test("a failed call is recorded as an error, and the error still reaches the caller", async () => {
  next = async () => { throw Object.assign(new Error(`API down: ${SECRET}`), { name: "APIConnectionError" }); };
  await assert.rejects(A.aiExtract(extractArgs(vendorId)), /API down/);
  const r = all<Record<string, unknown>>("SELECT * FROM ai_usage ORDER BY id DESC LIMIT 1")[0];
  assert.equal(r.ok, 0);
  assert.equal(r.input_tokens, 0);
  assert.ok(!JSON.stringify(r).includes("777"), "the error message (which may hold content) isn't stored");
});

test("a fallback answer is priced at the model that actually answered", async () => {
  next = ok({ reply: "Hi!", needs_owner: false, owner_reason: null }, { input_tokens: 500, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, "claude-sonnet-5-5");
  await A.aiDraft({ vendor: E.getVendor(vendorId)!, items: [], messages: [], facts: { purpose: "ask_info", details: EMPTY_DETAILS, quote: null, available: null, missing: [], holdHours: null, partnerSuggestions: [], referredTo: null, depositNote: "" } });
  const r = all<Record<string, unknown>>("SELECT * FROM ai_usage ORDER BY id DESC LIMIT 1")[0];
  assert.equal(r.model, "claude-sonnet-5-5");
  assert.equal(r.purpose, "draft");
});

test("recording never breaks a reply", async () => {
  run("ALTER TABLE ai_usage RENAME TO ai_usage_off");
  const warn = console.warn; console.warn = () => {};
  try {
    next = ok({ reply: "Still works", needs_owner: false, owner_reason: null });
    const out = await A.aiDraft({ vendor: E.getVendor(vendorId)!, items: [], messages: [], facts: { purpose: "ask_info", details: EMPTY_DETAILS, quote: null, available: null, missing: [], holdHours: null, partnerSuggestions: [], referredTo: null, depositNote: "" } });
    assert.equal(out.reply, "Still works");
  } finally {
    console.warn = warn;
    run("ALTER TABLE ai_usage_off RENAME TO ai_usage");
  }
});

test("demo usage is kept out of the totals and shown on its own", async () => {
  next = ok({ ...EMPTY_DETAILS, contact_name: null, date_text: null, date_is_approximate: false, start_time: null, style: null, owner_reason: null, summary: null }, { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  await A.aiExtract(extractArgs(demoId));
  const s = U.usageSummary(new Date("2000-01-01"));
  assert.equal(s.demo.calls, 1);
  assert.equal(s.demo.cost, 4);
  assert.ok(s.total.cost < 1, "the demo's $4 isn't in the total");
  assert.ok(s.byVendor.every((v) => v.vendorId !== demoId));
  assert.deepEqual(s.byPurpose.map((p) => p.purpose).sort(), ["draft", "extract"]);
});
