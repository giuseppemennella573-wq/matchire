import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-")), "test.db");
delete process.env.ANTHROPIC_API_KEY;

const { createAccount } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const { run, get } = await import("../src/lib/db.ts");
const { addDays, sgToday } = await import("../src/lib/dates.ts");

// WhatsApp Cloud API stand-in: records every message posted to it.
type Sent = { to: string; type: string; text?: { body: string }; template?: { name: string; language: { code: string }; components: { parameters: { text: string }[] }[] } };
const sent: Sent[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  if (String(url).startsWith("https://graph.facebook.com/")) sent.push(JSON.parse(String(init?.body)));
  return new Response("{}", { status: 200 });
}) as typeof fetch;

const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let vendor: number;
before(() => {
  vendor = createAccount({ email: "wa@test.sg", password: "password1", name: "Ana Tan", business: "Snapbox SG", kind: "photobooth", samplePrices: true }).vendorId;
  run("UPDATE vendors SET wa_phone_number_id = '123', wa_token = 'test-token' WHERE id = ?", vendor);
});
beforeEach(() => run("UPDATE vendors SET auto_send = 0, followup_days = 2, wa_templates_approved = 0 WHERE id = ?", vendor));

/** A WhatsApp enquiry whose quote goes out at t0, with the planner's last message `inboundHoursAgo` before that. */
async function quoted(phone: string, inDays: number, inboundHoursAgo: number) {
  const date = addDays(sgToday(), inDays);
  const [, m, d] = date.split("-");
  const t0 = Date.now();
  const { enquiryId } = E.ingest({ vendorId: vendor, channel: "whatsapp", handle: phone, name: "Mei Lin", text: `Hi! Photobooth for my 21st on ${+d} ${MON[+m - 1]} evening, about 80 guests, 3 hours. Budget $900` });
  await E.processEnquiry(vendor, enquiryId);
  run("UPDATE enquiries SET last_inbound_at = ? WHERE id = ?", iso(t0 - inboundHoursAgo * H), enquiryId);
  const r = await E.sendDraft(vendor, E.pendingDraft(enquiryId)!.id, { now: iso(t0) });
  assert.equal(r.status, "sent");
  return { id: enquiryId, t0, date };
}
const digits = (p: string) => p.replace(/\D/g, "");
const sentTo = (phone: string) => sent.filter((s) => s.to === digits(phone));

test("nudge inside the window goes out as free-form text at its normal time", async () => {
  run("UPDATE vendors SET followup_days = 0.5 WHERE id = ?", vendor);
  const phone = "+65 9000 0001";
  const { id, t0 } = await quoted(phone, 21, 0);
  assert.equal(E.getEnquiry(vendor, id)!.next_followup_at, iso(t0 + 12 * H), "12h nudge is before the window closes, so it isn't moved");

  run("UPDATE vendors SET auto_send = 1 WHERE id = ?", vendor);
  const n = sentTo(phone).length;
  await E.tick(iso(t0 + 12 * H + 60_000));
  assert.equal(sentTo(phone).length, n + 1);
  assert.equal(sentTo(phone).at(-1)!.type, "text");
  assert.equal(E.pendingDraft(id), undefined);
});

test("nudge due after the window is pulled forward to an hour before it closes", async () => {
  const phone = "+65 9000 0002";
  const { id, t0 } = await quoted(phone, 22, 0);
  // Default nudge is at 24h; the window closes 24h after the planner's message, so it moves to 23h.
  assert.equal(E.getEnquiry(vendor, id)!.next_followup_at, iso(t0 + 23 * H));

  run("UPDATE vendors SET auto_send = 1 WHERE id = ?", vendor);
  const n = sentTo(phone).length;
  await E.tick(iso(t0 + 23 * H + 60_000));
  assert.equal(sentTo(phone).length, n + 1);
  assert.equal(sentTo(phone).at(-1)!.type, "text");
});

test("nudge that can't be pulled forward 4h past the quote is sent as the quote_nudge template", async () => {
  run("UPDATE vendors SET wa_templates_approved = 1 WHERE id = ?", vendor);
  const phone = "+65 9000 0003";
  // Planner last wrote 21h before the quote: the window closes 3h after it, too soon for a nudge.
  const { id, t0, date } = await quoted(phone, 23, 21);
  assert.equal(E.getEnquiry(vendor, id)!.next_followup_at, iso(t0 + 24 * H), "not moved");

  run("UPDATE vendors SET auto_send = 1 WHERE id = ?", vendor);
  const n = sentTo(phone).length;
  await E.tick(iso(t0 + 24 * H + 60_000));
  assert.equal(sentTo(phone).length, n + 1);
  const msg = sentTo(phone).at(-1)!;
  assert.equal(msg.type, "template");
  assert.equal(msg.template!.name, "quote_nudge");
  assert.equal(msg.template!.language.code, "en");
  const params = msg.template!.components[0].parameters.map((p) => p.text);
  assert.equal(params[0], "Mei");
  const out = get<{ body: string; status: string; template: string }>("SELECT * FROM messages WHERE enquiry_id = ? AND purpose = 'followup'", id)!;
  assert.equal(out.status, "sent");
  assert.ok(out.template);
  assert.equal(out.body, `Hi Mei, just checking you saw our quote for ${params[1]}. Happy to answer any questions. Reply here anytime.`);
  assert.match(params[1], new RegExp(String(Number(date.slice(8)))));
});

test("template not approved: nothing is sent, the follow-up is flagged for the vendor", async () => {
  const phone = "+65 9000 0004";
  const { id, t0 } = await quoted(phone, 24, 21);
  run("UPDATE vendors SET auto_send = 1 WHERE id = ?", vendor);
  const before = sentTo(phone).length;
  const warn = console.warn;
  const logged: string[] = [];
  console.warn = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    await E.tick(iso(t0 + 24 * H + 60_000));
  } finally {
    console.warn = warn;
  }
  assert.equal(sentTo(phone).length, before, "nothing sent");
  assert.ok(logged.some((l) => l.includes("quote_nudge") && l.includes("not sent")));
  const e = E.getEnquiry(vendor, id)!;
  assert.ok(e.owner_reason?.startsWith(E.NEEDS_TEMPLATE_APPROVAL));
  const draft = E.pendingDraft(id)!;
  assert.ok(draft.template, "draft shows the template text");
  assert.match(draft.body, /^Hi Mei, just checking you saw our quote/);

  // Sending by hand is refused too, until the vendor marks the templates approved.
  const r = await E.sendDraft(vendor, draft.id, { now: iso(t0 + 25 * H) });
  assert.equal(r.status, "manual");
  assert.equal(sentTo(phone).length, before);
  run("UPDATE vendors SET wa_templates_approved = 1 WHERE id = ?", vendor);
  const r2 = await E.sendDraft(vendor, draft.id, { now: iso(t0 + 25 * H) });
  assert.equal(r2.status, "sent");
  assert.equal(sentTo(phone).at(-1)!.template!.name, "quote_nudge");
});

test("a free-form follow-up approved after the window closed goes out as a template instead", async () => {
  run("UPDATE vendors SET wa_templates_approved = 1 WHERE id = ?", vendor);
  const phone = "+65 9000 0005";
  run("UPDATE vendors SET followup_days = 0.5 WHERE id = ?", vendor);
  const { id, t0 } = await quoted(phone, 25, 0);
  await E.tick(iso(t0 + 12 * H + 60_000)); // auto-send is off: the free-form draft waits
  const draft = E.pendingDraft(id)!;
  assert.equal(draft.template, null);
  const n = sentTo(phone).length;
  const r = await E.sendDraft(vendor, draft.id, { body: "Edited text", now: iso(t0 + 26 * H) });
  assert.equal(r.status, "sent");
  assert.equal(sentTo(phone).length, n + 1);
  assert.equal(sentTo(phone).at(-1)!.type, "template");
  assert.match(get<{ body: string }>("SELECT body FROM messages WHERE id = ?", draft.id)!.body, /^Hi Mei, just checking/);
});
