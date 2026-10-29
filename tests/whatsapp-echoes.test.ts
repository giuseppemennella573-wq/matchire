import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Coexistence: the vendor also answers from the WhatsApp Business app on their
// phone. Meta sends Matchire a copy (smb_message_echoes); the vendor's reply
// stands, so Matchire drops its draft and stops following up.

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-")), "test.db");
delete process.env.ANTHROPIC_API_KEY;

const { createAccount } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const { run, get, all } = await import("../src/lib/db.ts");
const { addDays, sgToday } = await import("../src/lib/dates.ts");

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
let vendor: number;
before(() => {
  vendor = createAccount({ email: "booth@test.sg", password: "password1", name: "Ana", business: "Snapbox SG", kind: "photobooth", samplePrices: true }).vendorId;
});

function enquiry(phone: string, inDays: number) {
  const [, m, d] = addDays(sgToday(), inDays).split("-");
  return E.ingest({ vendorId: vendor, channel: "whatsapp", handle: phone, name: "Mei", text: `Hi! Photobooth for my 21st on ${+d} ${MON[+m - 1]} evening, 80 guests, 3 hours.` }).enquiryId;
}

test("a reply from the vendor's phone joins the conversation and drops Matchire's draft", async () => {
  const id = enquiry("+65 9123 4567", 20);
  await E.processEnquiry(vendor, id);
  assert.ok(E.pendingDraft(id), "Matchire drafted a reply");

  // Meta writes the planner's number without "+" or spaces.
  const r = E.recordPhoneReply(vendor, "6591234567", "Hi Mei! Yes we're free, I'll send you the details now.");
  assert.equal(r?.enquiryId, id);
  assert.equal(E.pendingDraft(id), undefined, "the draft is gone, so the planner can't get a second answer");
  const last = E.getMessages(id).at(-1)!;
  assert.equal(last.direction, "out");
  assert.equal(last.purpose, "phone_reply");
  assert.equal(last.status, "manual");
  const e = E.getEnquiry(vendor, id)!;
  assert.equal(e.owner_reason, null);
  assert.equal(e.next_followup_at, null);
  assert.ok(e.first_response_at);
  assert.equal(e.status, "awaiting_info");
});

test("follow-ups stop once the vendor has replied from their phone", async () => {
  const id = enquiry("+65 9123 0002", 21);
  await E.processEnquiry(vendor, id);
  E.markDraftSentManually(vendor, E.pendingDraft(id)!.id);
  assert.ok(E.getEnquiry(vendor, id)!.next_followup_at, "a follow-up was scheduled after the quote");

  E.recordPhoneReply(vendor, "6591230002", "Mei, just called you, all sorted!");
  assert.equal(E.getEnquiry(vendor, id)!.next_followup_at, null);
  await E.tick(new Date(Date.now() + 3 * 86400_000).toISOString());
  assert.equal(E.pendingDraft(id), undefined, "no follow-up drafted");
});

test("a phone reply that lands while Matchire is drafting wins", async () => {
  const id = enquiry("+65 9123 0003", 22);
  // Stand-in for a reply that arrives mid-draft (after processing started).
  run("INSERT INTO messages (enquiry_id, direction, body, status, purpose, created_at) VALUES (?, 'out', 'On it!', 'manual', 'phone_reply', ?)", id, new Date(Date.now() + 60_000).toISOString());
  const r = await E.processEnquiry(vendor, id);
  assert.equal(r.draftId, null);
  assert.equal(E.pendingDraft(id), undefined);

  // Later, asking for a draft on purpose still works.
  run("UPDATE messages SET created_at = ? WHERE enquiry_id = ? AND purpose = 'phone_reply'", new Date(Date.now() - 60_000).toISOString(), id);
  const again = await E.processEnquiry(vendor, id);
  assert.ok(again.draftId);
});

test("messages to people who aren't an enquiry are ignored, and echoes aren't recorded twice", async () => {
  const before = (get<{ n: number }>("SELECT COUNT(*) n FROM enquiries")!).n;
  assert.equal(E.recordPhoneReply(vendor, "6588887777", "Hi mum, home by 7"), null);
  assert.equal((get<{ n: number }>("SELECT COUNT(*) n FROM enquiries")!).n, before, "no enquiry created for a personal chat");

  const id = enquiry("+65 9123 0004", 23);
  E.recordPhoneReply(vendor, "6591230004", "Thanks Mei!");
  E.recordPhoneReply(vendor, "6591230004", "Thanks Mei!");
  assert.equal(all("SELECT 1 FROM messages WHERE enquiry_id = ? AND purpose = 'phone_reply'", id).length, 1);
});
