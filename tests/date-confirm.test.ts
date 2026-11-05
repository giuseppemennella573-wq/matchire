import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-dc-")), "test.db");
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "SMTP_HOST", "RESEND_API_KEY"]) delete process.env[k];

const { createAccount } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const A = await import("../src/lib/ai.ts");
const { get } = await import("../src/lib/db.ts");
const { addDays, dayOfWeek, formatDate, sgToday, weekdayMismatch } = await import("../src/lib/dates.ts");
const { parseEnquiry } = await import("../src/lib/heuristics.ts");

// A Sunday about three weeks out, written as "Sat <its date>": the weekday doesn't match.
let sun = addDays(sgToday(), 20);
while (dayOfWeek(sun) !== 0) sun = addDays(sun, 1);
const sat = addDays(sun, -1);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const wrong = `Sat ${+sun.slice(8)} ${MON[+sun.slice(5, 7) - 1]}`;
const PRICE = /SGD|S\$|\$\s?\d/;

let v: number;
before(() => {
  v = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth", samplePrices: true }).vendorId;
});

test("the weekday check reads the common ways of writing a date", () => {
  assert.deepEqual(weekdayMismatch(`party on ${wrong} evening`, sun)?.options, [sat, sun]);
  assert.deepEqual(weekdayMismatch(`party on ${wrong} evening`, sat)?.options, [sat, sun], "even if the reader already picked the Saturday");
  assert.equal(weekdayMismatch(`Sun ${+sun.slice(8)} ${MON[+sun.slice(5, 7) - 1]}`, sun), null, "a matching weekday is fine");
  assert.equal(weekdayMismatch(`${+sun.slice(8)} ${MON[+sun.slice(5, 7) - 1]}`, sun), null, "no weekday, nothing to check");
});

test("wrong weekday: the reply only asks which date; no availability, no price, no hold", async () => {
  const { enquiryId } = E.ingest({ vendorId: v, channel: "whatsapp", text: `Hi! Classic booth for my daughter's 21st on ${wrong}, evening, 80 guests, 3 hours. How much?`, name: "Pat", handle: "+65 9100 0001" });
  await E.processEnquiry(v, enquiryId);
  const e = E.getEnquiry(v, enquiryId)!;
  const draft = E.pendingDraft(enquiryId)!;
  assert.equal(draft.purpose, "confirm_date");
  const fmt = (d: string) => formatDate(d).replace(",", "");
  assert.match(draft.body, new RegExp(`did you mean ${fmt(sat)} or ${fmt(sun)}\\?`));
  assert.doesNotMatch(draft.body, /available|holding|hold the date/i);
  assert.doesNotMatch(draft.body, PRICE);
  assert.equal(e.quote, null, "no quote");
  const d = E.parseDetails(e);
  assert.equal(d.date_to_confirm, true, "shows as 'Needs date confirmed'");
  assert.equal(d.event_date, null);
  await E.markDraftSentManually(v, draft.id);
  assert.equal(get("SELECT 1 FROM holds WHERE enquiry_id = ? AND status = 'active'", enquiryId), undefined, "no hold");

  // "Saturday": that's the date now, quoted as usual, and the question isn't asked again.
  E.ingest({ vendorId: v, channel: "whatsapp", text: "Saturday please!", handle: "+65 9100 0001" });
  await E.processEnquiry(v, enquiryId);
  const after = E.parseDetails(E.getEnquiry(v, enquiryId)!);
  assert.equal(after.event_date, sat);
  assert.equal(after.date_confirmed, sat);
  assert.equal(after.date_to_confirm, false);
  assert.notEqual(E.pendingDraft(enquiryId)!.purpose, "confirm_date");
  E.ingest({ vendorId: v, channel: "whatsapp", text: "Also we'd like a custom print frame", handle: "+65 9100 0001" });
  await E.processEnquiry(v, enquiryId);
  assert.equal(E.parseDetails(E.getEnquiry(v, enquiryId)!).event_date, sat, "the confirmed date stands");
  assert.notEqual(E.pendingDraft(enquiryId)!.purpose, "confirm_date");
});

test("with the AI on, the date question is still the plain template, even if the AI would claim availability", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  let drafted = 0;
  A.setClientForTests({ beta: { messages: { parse: async (req: { model: string; system: unknown; messages: { content: string }[] }) => {
    const system = typeof req.system === "string" ? req.system : (req.system as { text: string }[]).map((b) => b.text).join("");
    const usage = { input_tokens: 1, output_tokens: 1 };
    if (/extract booking details/.test(system)) {
      const d = parseEnquiry(req.messages[0].content.split("<conversation>")[1] ?? "", E.getItems(v), sgToday());
      // The AI "helpfully" reads the Saturday.
      return { model: req.model, stop_reason: "end_turn", usage, parsed_output: { ...d, event_date: sat, intent: "new_enquiry", relevance: "enquiry", relevance_reason: null } };
    }
    drafted++;
    return { model: req.model, stop_reason: "end_turn", usage, parsed_output: { reply: "Good news: we're available that evening! SGD 570.", needs_owner: false, owner_reason: null } };
  } } } });
  try {
    const { enquiryId } = E.ingest({ vendorId: v, channel: "whatsapp", text: `Booth on ${wrong} evening, 50 guests?`, handle: "+65 9100 0002" });
    await E.processEnquiry(v, enquiryId);
    const draft = E.pendingDraft(enquiryId)!;
    assert.equal(draft.purpose, "confirm_date");
    assert.doesNotMatch(draft.body, /available|SGD/);
    assert.equal(drafted, 0, "the AI isn't asked to draft the date question");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
