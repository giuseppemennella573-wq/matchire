import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-cl-")), "test.db");
process.env.ANTHROPIC_API_KEY = "test-key";
for (const k of ["SMTP_HOST", "RESEND_API_KEY"]) delete process.env[k];

const { createAccount } = await import("../src/lib/accounts.ts");
const C = await import("../src/lib/clients.ts");
const A = await import("../src/lib/ai.ts");
const E = await import("../src/lib/engine.ts");
const { run } = await import("../src/lib/db.ts");

let mel: number, ali: number;

/** A past enquiry, with an optional sent reply. */
function past(vendorId: number, o: { channel?: string; handle?: string | null; email?: string | null; status: string; daysAgo: number; label?: string; total?: number; eventDate?: string; replied?: boolean }) {
  const at = new Date(Date.now() - o.daysAgo * 86400_000).toISOString();
  const quote = o.label ? JSON.stringify({ package_id: null, lines: [{ label: o.label, amount: o.total ?? 0 }], total: o.total ?? 0, offpeak: false, issues: [] }) : null;
  const id = run(
    "INSERT INTO enquiries (vendor_id, channel, contact_name, contact_handle, contact_email, status, quote, event_date, created_at, updated_at) VALUES (?, ?, 'Sarah', ?, ?, ?, ?, ?, ?, ?)",
    vendorId, o.channel ?? "whatsapp", o.handle ?? null, o.email ?? null, o.status, quote, o.eventDate ?? null, at, at,
  );
  if (o.replied) run("INSERT INTO messages (enquiry_id, direction, body, status, purpose, created_at) VALUES (?, 'out', 'Hi Sarah!', 'manual', 'phone_reply', ?)", id, at);
  return id;
}
const now = (vendorId: number, channel: string, handle: string | null, email: string | null = null) =>
  run("INSERT INTO enquiries (vendor_id, channel, contact_name, contact_handle, contact_email, status) VALUES (?, ?, 'Sarah', ?, ?, 'new')", vendorId, channel, handle, email);

before(() => {
  mel = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth" }).vendorId;
  ali = createAccount({ email: "ali@cater.sg", password: "password1", name: "Ali", business: "Ali Catering", kind: "caterer" }).vendorId;
});

test("a first-time client shows nothing", () => {
  const id = now(mel, "whatsapp", "+65 9000 1111");
  assert.equal(C.clientHistory(E.getEnquiry(mel, id)!), null);
});

test("a regular client: bookings counted, last booking named, number formats matched", () => {
  past(mel, { handle: "+65 9123 4501", status: "won", daysAgo: 400, label: "Classic Booth 2h", eventDate: "2025-09-20" });
  past(mel, { handle: "91234501", status: "won", daysAgo: 230, label: "Classic Booth 3h", total: 1000, eventDate: "2026-03-14" });
  past(mel, { handle: "+65 9123 4501", status: "lost", daysAgo: 100 }); // never answered: doesn't count
  const id = now(mel, "whatsapp", "+6591234501");
  const h = C.clientHistory(E.getEnquiry(mel, id)!)!;
  assert.equal(h.verified, true);
  assert.equal(h.bookings, 2);
  assert.equal(h.earlier.length, 2);
  assert.equal(C.clientNote(h), "Booked with you 2× · last: Classic Booth 3h, 14 Mar 2026");
});

test("history comes only from this vendor", () => {
  past(ali, { handle: "+65 9777 0000", status: "won", daysAgo: 50, label: "Buffet" });
  const id = now(mel, "whatsapp", "+65 9777 0000");
  assert.equal(C.clientHistory(E.getEnquiry(mel, id)!), null);
});

test("someone who enquired and got a reply but never booked: 'Enquired before'", () => {
  past(mel, { email: "kim@x.sg", channel: "email", status: "lost", daysAgo: 140, replied: true });
  const id = now(mel, "email", "Kim@X.sg", "Kim@X.sg");
  const h = C.clientHistory(E.getEnquiry(mel, id)!)!;
  assert.equal(h.bookings, 0);
  assert.match(C.clientNote(h), /^Enquired before \(\w{3} \d{4}\)$/);
  assert.equal(C.returningForDraft(h), true, "email counts as verified");
});

test("a web-form match is shown as unverified and never reaches the draft", () => {
  const id = now(mel, "web", "+65 9123 4501");
  const h = C.clientHistory(E.getEnquiry(mel, id)!)!;
  assert.equal(h.verified, false);
  assert.match(C.clientNote(h), /\(from the web form, unverified\)$/);
  assert.equal(C.returningForDraft(h), false);
});

test("the draft is told only 'returning client', never past prices, packages or dates", async () => {
  let facts = "";
  let system = "";
  A.setClientForTests({ beta: { messages: { parse: async (req: { system: string; messages: { content: string }[]; output_config: { format: unknown } }) => {
    const isDraft = /You write replies/.test(req.system);
    if (isDraft) { system = req.system; facts = req.messages[0].content; }
    return {
      model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
      parsed_output: isDraft ? { reply: "Great to hear from you again! What's the date?", needs_owner: false, owner_reason: null }
        : { contact_name: null, event_date: null, date_text: null, date_is_approximate: false, slot: null, start_time: null, hours: null, pax: null, budget: null, event_type: null, location: null, style: null, package_id: null, addon_ids: [], needs: [], questions: [], needs_owner: false, owner_reason: null, intent: "new_enquiry", summary: null },
    };
  } } } });
  run("UPDATE enquiries SET status = 'lost' WHERE status = 'new'"); // the earlier tests' open enquiries would otherwise absorb this message
  const { enquiryId } = E.ingest({ vendorId: mel, channel: "whatsapp", text: "Hi Mel! Need the booth again for a party", name: "Sarah", handle: "+65 9123 4501" });
  await E.processEnquiry(mel, enquiryId);
  assert.match(facts, /"returningClient": true/);
  assert.match(system, /returning client/);
  for (const leak of ["Classic Booth 3h", "1000", "2026-03-14", "14 Mar", "2025-09-20"]) assert.ok(!facts.includes(leak), `${leak} leaked into the draft`);

  // Same person through the web form: not told.
  const web = E.ingest({ vendorId: mel, channel: "web", text: "Hi again, party next month", name: "Sarah", handle: "+65 9123 4502" }).enquiryId;
  run("UPDATE enquiries SET contact_handle = '+65 9123 4501' WHERE id = ?", web);
  await E.processEnquiry(mel, web);
  assert.match(facts, /"returningClient": false/);
});

