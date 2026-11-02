import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-style-")), "test.db");
process.env.ANTHROPIC_API_KEY = "test-key";
for (const k of ["SMTP_HOST", "RESEND_API_KEY"]) delete process.env[k];

const { createAccount } = await import("../src/lib/accounts.ts");
const S = await import("../src/lib/style.ts");
const A = await import("../src/lib/ai.ts");
const E = await import("../src/lib/engine.ts");
const { run, get } = await import("../src/lib/db.ts");
const { EMPTY_DETAILS } = await import("../src/lib/types.ts");

type Acc = { userId: number; vendorId: number };
let mel: Acc, ali: Acc;

/** An enquiry with one vendor-written message of the given kind. */
function reply(vendorId: number, body: string, kind: "phone" | "edited" | "unchanged" | "auto" | "template", contact = { name: "Sarah Tan", handle: "+65 9123 4501" }) {
  const eid = run("INSERT INTO enquiries (vendor_id, channel, contact_name, contact_handle, status) VALUES (?, 'whatsapp', ?, ?, 'quoted')", vendorId, contact.name, contact.handle);
  if (kind === "phone") run("INSERT INTO messages (enquiry_id, direction, body, status, purpose) VALUES (?, 'out', ?, 'manual', 'phone_reply')", eid, body);
  else run(
    "INSERT INTO messages (enquiry_id, direction, body, status, purpose, edited, template) VALUES (?, 'out', ?, 'sent', 'quote', ?, ?)",
    eid, body, kind === "edited" ? 1 : 0, kind === "template" ? '{"name":"quote_nudge"}' : null,
  );
  return eid;
}

before(() => {
  mel = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth" });
  ali = createAccount({ email: "ali@cater.sg", password: "password1", name: "Ali", business: "Ali Catering", kind: "caterer" });
});

test("prices, dates, times, phone numbers, emails and the client's name are masked", () => {
  const out = S.cleanExample(
    "Hi Sarah! Classic Booth 3h is SGD 850, guestbook S$150, so $1,000 all in (or 1.2k for 4h). 30% deposit by 14 Nov 2026, " +
      "event on 15/11 from 7pm to 10:30pm. Call me at +65 9123 4501 or 8123-4567, or email mel@snap.sg. 150 guests ok!",
    ["Sarah Tan", "+65 9123 4501", null],
  );
  for (const leak of ["Sarah", "850", "150", "1,000", "1.2k", "30%", "14 Nov", "15/11", "7pm", "10:30", "9123", "8123", "mel@snap.sg"]) {
    assert.ok(!out.includes(leak), `"${leak}" leaked: ${out}`);
  }
  assert.match(out, /^Hi \[name\]! Classic Booth 3h is \[price\]/);
  assert.match(out, /\[percent\] deposit by \[date\]/);
  assert.match(out, /\[email\]/);
});

test("examples come only from this vendor's own replies: phone replies and edited drafts, never unchanged drafts, auto-sends or templates", () => {
  reply(mel.vendorId, "Hey there! So sorry for the slow reply, we were at an event 🙈 Yes we're free that day!", "phone");
  reply(mel.vendorId, "Hi lovely! Totally doable 😊 Let me know your venue and I'll lock it in for you.", "edited");
  reply(mel.vendorId, "Dear Sir/Madam, thank you for your enquiry. Please find our quote below.", "unchanged");
  reply(mel.vendorId, "AUTO: here is our standard quote for your event, thanks.", "auto");
  reply(mel.vendorId, "Hi, just checking you saw our quote. Reply here anytime.", "template");
  reply(ali.vendorId, "Ali's own words about halal buffets, never for Mel's drafts.", "phone", { name: "Bob", handle: "+65 9000 0001" });

  const ex = S.styleExamples(mel.vendorId);
  assert.equal(ex.length, 2);
  assert.match(ex[0], /slow reply/, "phone replies come first");
  assert.match(ex[1], /Totally doable/);
  assert.ok(!ex.join(" ").includes("Dear Sir"), "a draft sent unchanged is Matchire's own words");
  assert.ok(!ex.join(" ").includes("AUTO"));
  assert.ok(!ex.join(" ").includes("checking you saw"));
  assert.ok(!ex.join(" ").includes("halal"), "never another vendor's replies");
  assert.equal(S.styleExampleCount(ali.vendorId), 1);
});

test("at most 5 examples, a mix of situations first, too-short replies skipped", () => {
  const v = createAccount({ email: "many@x.sg", password: "password1", name: "Max", business: "Many Co", kind: "photobooth" }).vendorId;
  for (let i = 0; i < 8; i++) reply(v, `Phone reply number ${"x".repeat(i + 1)}: hello there, happy to help with your party!`, "phone");
  reply(v, "ok!", "phone");
  const ex = S.styleExamples(v);
  assert.equal(ex.length, 5);
  assert.ok(!ex.includes("ok!"));
});

test("sending a draft records whether the vendor changed it", async () => {
  const eid = run("INSERT INTO enquiries (vendor_id, channel, contact_name, contact_handle, status) VALUES (?, 'web', 'Kim', 'kim@x.sg', 'new')", mel.vendorId);
  const d1 = run("INSERT INTO messages (enquiry_id, direction, body, status, purpose) VALUES (?, 'out', 'Hi Kim, thanks for asking!', 'draft', 'ask_info')", eid);
  await E.markDraftSentManually(mel.vendorId, d1, "Hi Kim,  thanks for asking!\n");
  assert.equal(get<{ edited: number }>("SELECT edited FROM messages WHERE id = ?", d1)!.edited, 0, "spacing alone isn't an edit");
  const d2 = run("INSERT INTO messages (enquiry_id, direction, body, status, purpose) VALUES (?, 'out', 'Hi Kim, thanks for asking!', 'draft', 'ask_info')", eid);
  await E.markDraftSentManually(mel.vendorId, d2, "Heyyy Kim!! So glad you asked 😍 What's the date?");
  assert.equal(get<{ edited: number }>("SELECT edited FROM messages WHERE id = ?", d2)!.edited, 1);
  assert.ok(S.styleExamples(mel.vendorId).some((e) => e.includes("So glad you asked")));
});

test("the draft prompt gets the examples; switching the setting off removes them; an example's price can't reach a reply", async () => {
  let system = "";
  A.setClientForTests({ beta: { messages: { parse: async (req: { system: string }) => {
    if (typeof req.system !== "string") req.system = (req.system as unknown as { text: string }[]).map((b) => b.text).join("\n"); // cached prompts arrive as blocks
    system = req.system;
    return { model: "claude-opus-5-5", stop_reason: "end_turn", parsed_output: { reply: "Hi! Classic Booth 3h is SGD 850.", needs_owner: false, owner_reason: null }, usage: { input_tokens: 1, output_tokens: 1 } };
  } } } });
  const facts = { purpose: "ask_info" as const, details: EMPTY_DETAILS, quote: null, available: null, missing: [], holdHours: null, partnerSuggestions: [], referredTo: null, depositNote: "" };
  await A.aiDraft({ vendor: E.getVendor(mel.vendorId)!, items: [], messages: [], facts, styleExamples: S.styleExamples(mel.vendorId) });
  assert.match(system, /Examples of how Snap Co writes\. Copy the style/);
  assert.match(system, /slow reply/);
  assert.ok(!/SGD \d/.test(system.slice(system.indexOf("Examples of how"))), "examples carry no prices");

  // Through the whole pipeline: the setting decides, and the "never invent a price" check still catches a price from nowhere.
  const eid = E.ingest({ vendorId: mel.vendorId, channel: "whatsapp", text: "hi do you do birthdays?", name: "Zoe", handle: "+65 9555 0001" }).enquiryId;
  run("UPDATE vendors SET learn_style = 0 WHERE id = ?", mel.vendorId);
  system = "";
  await E.processEnquiry(mel.vendorId, eid);
  assert.ok(system && !system.includes("Examples of how"), "setting off: no examples");
  const draft = get<{ body: string }>("SELECT body FROM messages WHERE enquiry_id = ? AND status = 'draft'", eid)!;
  assert.ok(!draft.body.includes("850"), "a price that isn't on the price list never goes out");
  run("UPDATE vendors SET learn_style = 1 WHERE id = ?", mel.vendorId);
});
