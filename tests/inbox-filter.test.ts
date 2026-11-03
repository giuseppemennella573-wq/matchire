import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-filter-")), "test.db");
process.env.ANTHROPIC_API_KEY = "test-key";
for (const k of ["SMTP_HOST", "RESEND_API_KEY", "MATCHIRE_EXTRACT_MODEL"]) delete process.env[k];

const { createAccount } = await import("../src/lib/accounts.ts");
const A = await import("../src/lib/ai.ts");
const E = await import("../src/lib/engine.ts");
const { run, get } = await import("../src/lib/db.ts");
const { parseEnquiry } = await import("../src/lib/heuristics.ts");
const { sgToday } = await import("../src/lib/dates.ts");

let v: number;
// What the fake AI says about relevance for the next reading call.
let verdict: { relevance: "enquiry" | "not_enquiry" | "unsure"; relevance_reason: string | null } = { relevance: "enquiry", relevance_reason: null };
A.setClientForTests({ beta: { messages: { parse: async (req: { model: string; system: unknown; messages: { content: string }[] }) => {
  const system = typeof req.system === "string" ? req.system : (req.system as { text: string }[]).map((b) => b.text).join("");
  const usage = { input_tokens: 1, output_tokens: 1 };
  if (/extract booking details/.test(system)) {
    const convo = req.messages[0].content.split("<conversation>")[1] ?? "";
    const d = parseEnquiry(convo, E.getItems(v), sgToday());
    return { model: req.model, stop_reason: "end_turn", usage, parsed_output: { ...d, intent: "new_enquiry", ...verdict } };
  }
  return { model: req.model, stop_reason: "end_turn", usage, parsed_output: { reply: "Hi! Happy to help. What's the date and how many guests?", needs_owner: false, owner_reason: null } };
} } } });

let n = 0;
const msg = async (text: string, channel: "whatsapp" | "email" | "web" | "manual" = "whatsapp", handle = `+65 9300 ${String(1000 + n++)}`) => {
  const { enquiryId } = E.ingest({ vendorId: v, channel, text, name: "X", handle });
  await E.processEnquiry(v, enquiryId);
  return { id: enquiryId, e: E.getEnquiry(v, enquiryId)!, draft: E.pendingDraft(enquiryId), handle };
};

before(() => {
  v = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth", samplePrices: true }).vendorId;
});

test("'not an enquiry' is filed under Other with the reason: no draft, not counted", async () => {
  verdict = { relevance: "not_enquiry", relevance_reason: "Personal message" };
  const before = E.stats(v).enquiries;
  const { e, draft } = await msg("Bro you coming for dinner tonight?");
  assert.deepEqual([e.status, e.filed_reason], ["other", "Personal message"]);
  assert.equal(draft, undefined);
  assert.equal(e.next_followup_at, null);
  assert.equal(E.stats(v).enquiries, before, "not in stats");
  assert.equal(E.countFiled(v), 1);
});

test("'unsure' stays in the inbox with 'Check this', and auto-send never sends it", async () => {
  run("UPDATE vendors SET auto_send = 1 WHERE id = ?", v);
  verdict = { relevance: "unsure", relevance_reason: "Could be a supplier" };
  const r = await msg("Hi, do you work with event companies?");
  assert.equal(r.e.status, "new");
  assert.equal(r.e.filed_reason, "Could be a supplier");
  assert.ok(r.draft, "drafted as usual");
  assert.match(r.e.owner_reason ?? "", /Check this: Could be a supplier/);
  assert.equal(get<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE enquiry_id = ? AND direction = 'out' AND status IN ('sent','manual')", r.id)!.n, 0, "nothing went out on its own");
  run("UPDATE vendors SET auto_send = 0 WHERE id = ?", v);
});

test("website-form, pasted and referred enquiries are never filed; neither is a conversation the vendor answered", async () => {
  verdict = { relevance: "not_enquiry", relevance_reason: "Spam" };
  assert.notEqual((await msg("Need a booth on 12 Dec", "web", "web@x.sg")).e.status, "other");
  assert.notEqual((await msg("Need a booth on 12 Dec", "manual", "+65 9400 0001")).e.status, "other");
  const ref = E.ingest({ vendorId: v, channel: "referral", text: "Booth for 12 Dec?", handle: "+65 9400 0002", referredFrom: v });
  await E.processEnquiry(v, ref.enquiryId);
  assert.notEqual(E.getEnquiry(v, ref.enquiryId)!.status, "other");
  // Answered by the vendor, then a message the AI calls irrelevant: stays.
  verdict = { relevance: "enquiry", relevance_reason: null };
  const live = await msg("Hi, booth for 19 Dec, 80 guests?");
  await E.markDraftSentManually(v, live.draft!.id);
  verdict = { relevance: "not_enquiry", relevance_reason: "Chit-chat" };
  E.ingest({ vendorId: v, channel: "whatsapp", text: "haha ok 👍", handle: live.handle });
  await E.processEnquiry(v, live.id);
  assert.notEqual(E.getEnquiry(v, live.id)!.status, "other");
});

test("'Move to Enquiries' brings it back with a normal draft, and it's never filed again", async () => {
  verdict = { relevance: "not_enquiry", relevance_reason: "Looks personal" };
  const { id, handle } = await msg("Hey it's Jo! Remember me? Need your booth for my wedding");
  assert.equal(E.getEnquiry(v, id)!.status, "other");
  await E.keepAsEnquiry(v, id);
  const e = E.getEnquiry(v, id)!;
  assert.deepEqual([e.status, e.filed_reason, e.kept], ["new", null, 1]);
  assert.ok(E.pendingDraft(id), "drafted");
  E.ingest({ vendorId: v, channel: "whatsapp", text: "lol", handle });
  await E.processEnquiry(v, id);
  assert.notEqual(E.getEnquiry(v, id)!.status, "other", "the vendor's word stands");
});

test("a filed contact's next message is read again, and comes back if it's an enquiry", async () => {
  verdict = { relevance: "not_enquiry", relevance_reason: "Wrong number" };
  const first = await msg("Is this Ah Seng?");
  verdict = { relevance: "enquiry", relevance_reason: null };
  const { enquiryId } = E.ingest({ vendorId: v, channel: "whatsapp", text: "Sorry wrong number earlier, but actually do you do booths for 20 Dec?", handle: first.handle });
  assert.equal(enquiryId, first.id, "joins the filed thread");
  await E.processEnquiry(v, enquiryId);
  assert.equal(E.getEnquiry(v, enquiryId)!.status, "new");
  assert.ok(E.pendingDraft(enquiryId));
});

test("rules mode (no AI) never files anything", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await msg("Bro you coming for dinner tonight?");
    assert.notEqual(r.e.status, "other");
    assert.equal(r.e.filed_reason, null);
  } finally {
    process.env.ANTHROPIC_API_KEY = "test-key";
  }
});
