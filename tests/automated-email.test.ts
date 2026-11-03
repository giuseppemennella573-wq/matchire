import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-auto-")), "test.db");
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "SMTP_HOST", "INBOUND_EMAIL_DOMAIN"]) delete process.env[k];
process.env.RESEND_API_KEY = "test";

const sent: { headers?: Record<string, string>; to: string[] }[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  if (String(url).includes("api.resend.com")) sent.push(JSON.parse(String(init?.body)));
  return Response.json({ id: "x" });
}) as typeof fetch;

const { createAccount } = await import("../src/lib/accounts.ts");
const A = await import("../src/lib/automated.ts");
const E = await import("../src/lib/engine.ts");
const { run, get, all } = await import("../src/lib/db.ts");

let v: number;
before(() => {
  v = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth", samplePrices: true }).vendorId;
});

test("headers are read from Postmark, Mailgun and SendGrid shapes", () => {
  assert.deepEqual(A.parseHeaders([{ Name: "Auto-Submitted", Value: "auto-replied" }]), { "auto-submitted": "auto-replied" });
  assert.deepEqual(A.parseHeaders('[["List-Unsubscribe", "<mailto:x@y>"], ["Precedence", "bulk"]]'), { "list-unsubscribe": "<mailto:x@y>", precedence: "bulk" });
  assert.deepEqual(A.parseHeaders("X-Autoreply: yes\r\nSubject: Out\r\n of office"), { "x-autoreply": "yes", subject: "Out of office" });
  assert.deepEqual(A.parseHeaders(undefined), {});
});

test("out-of-office, newsletters, bounces and no-reply senders are recognised; a person's email isn't", () => {
  const r = (h: Record<string, string>, from: string, subject: string) => A.automatedReason(h, from, subject);
  assert.equal(r({ "auto-submitted": "auto-replied" }, "sarah@x.sg", "Re: your enquiry"), "Out-of-office reply");
  assert.equal(r({}, "sarah@x.sg", "Automatic reply: Re: your enquiry with Snap Co"), "Out-of-office reply");
  assert.equal(r({}, "sarah@x.sg", "Out of Office until 12 Nov"), "Out-of-office reply");
  assert.equal(r({ "x-autoreply": "yes" }, "sarah@x.sg", "Thanks"), "Out-of-office reply");
  assert.equal(r({ "list-unsubscribe": "<https://x>" }, "news@venue.sg", "November deals"), "Newsletter");
  assert.equal(r({ precedence: "bulk" }, "promo@x.sg", "Sale"), "Newsletter");
  assert.equal(r({}, "MAILER-DAEMON@mail.example.com", "Undelivered Mail Returned to Sender"), "Delivery failure");
  assert.equal(r({}, "no-reply@bank.sg", "Your statement"), "Automatic email");
  assert.equal(r({ "auto-submitted": "auto-generated" }, "system@x.sg", "Invoice"), "Automatic email");
  assert.equal(r({ "auto-submitted": "no" }, "daniel@bluewave.sg", "Corporate D&D"), null);
  assert.equal(r({}, "daniel@bluewave.sg", "Quote for our D&D on 28 Nov"), null);
  assert.equal(r({}, "outofoffice.events@x.sg", "Booth for our party"), null, "only the subject or headers decide, not a name that happens to match");
});

test("an automated email with no open enquiry is filed under Other with its reason, never drafted", () => {
  const { enquiryId, note } = E.fileAsOther({ vendorId: v, channel: "email", text: "November deals\n\nBig sale!", handle: "news@venue.sg", email: "news@venue.sg", reason: "Newsletter" });
  assert.equal(note, false);
  const e = E.getEnquiry(v, enquiryId)!;
  assert.deepEqual([e.status, e.filed_reason], ["other", "Newsletter"]);
  assert.equal(E.pendingDraft(enquiryId), undefined);
  // The same sender's next one joins the same filed thread.
  const again = E.fileAsOther({ vendorId: v, channel: "email", text: "December deals", handle: "news@venue.sg", email: "news@venue.sg", reason: "Newsletter" });
  assert.equal(again.enquiryId, enquiryId);
  assert.equal(E.stats(v).enquiries, 0, "not counted as enquiries");
});

test("an auto-reply on an open enquiry becomes a short note; follow-ups carry on and nothing is answered", async () => {
  const { enquiryId } = E.ingest({ vendorId: v, channel: "email", text: "Hi, photobooth for 12 Dec evening, 100 guests at Raffles? How much?", handle: "sarah@x.sg", email: "sarah@x.sg" });
  await E.processEnquiry(v, enquiryId);
  await E.sendDraft(v, E.pendingDraft(enquiryId)!.id);
  const before = E.getEnquiry(v, enquiryId)!;
  assert.ok(before.next_followup_at, "a follow-up is scheduled");
  const r = E.fileAsOther({ vendorId: v, channel: "email", text: "I'm away until Monday", handle: "sarah@x.sg", email: "sarah@x.sg", reason: "Out-of-office reply" });
  assert.deepEqual(r, { enquiryId, note: true });
  const after = E.getEnquiry(v, enquiryId)!;
  assert.equal(after.next_followup_at, before.next_followup_at, "follow-ups unchanged");
  assert.equal(after.status, before.status);
  const last = all<{ direction: string; body: string }>("SELECT direction, body FROM messages WHERE enquiry_id = ? ORDER BY id DESC LIMIT 1", enquiryId)[0];
  assert.deepEqual({ ...last }, { direction: "note", body: "Out-of-office reply received (not answered)." });
  assert.ok(!all<{ body: string }>("SELECT body FROM messages WHERE enquiry_id = ?", enquiryId).some((m) => m.body.includes("away until Monday")), "the auto-reply's text isn't kept");
  assert.equal(E.pendingDraft(enquiryId), undefined, "no draft, so auto-send has nothing to send");
});

test("emails Matchire sends on its own are marked Auto-Submitted; the vendor's own sends aren't", async () => {
  run("UPDATE vendors SET auto_send = 1 WHERE id = ?", v);
  sent.length = 0;
  const { enquiryId } = E.ingest({ vendorId: v, channel: "email", text: "Hi! Booth for 19 Dec, 3 hours, 80 guests at Tampines, price?", handle: "kim@x.sg", email: "kim@x.sg" });
  const r = await E.processEnquiry(v, enquiryId);
  assert.equal(r.autoSent, true);
  assert.deepEqual(sent.at(-1)!.headers, { "Auto-Submitted": "auto-replied" });
  run("UPDATE vendors SET auto_send = 0 WHERE id = ?", v);
  const { enquiryId: e2 } = E.ingest({ vendorId: v, channel: "email", text: "Hello, booth on 20 Dec for 50 guests at Bishan, 2 hours?", handle: "lee@x.sg", email: "lee@x.sg" });
  await E.processEnquiry(v, e2);
  await E.sendDraft(v, E.pendingDraft(e2)!.id);
  assert.equal(sent.at(-1)!.headers, undefined, "a reply the vendor sends is a person's email");
  assert.ok(get("SELECT 1 FROM enquiries WHERE id = ?", e2));
});

test("the email webhook checks for automated mail before anything reaches the AI", () => {
  const src = readFileSync("src/app/api/webhooks/email/[token]/route.ts", "utf8");
  assert.ok(src.indexOf("automatedReason(") > 0 && src.indexOf("automatedReason(") < src.indexOf("ingest({"), "checked before ingest");
  assert.match(src, /fileAsOther\(/);
});
