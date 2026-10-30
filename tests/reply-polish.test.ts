import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-pol-")), "test.db");
delete process.env.ANTHROPIC_API_KEY;

const { createAccount, addItems } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const P = await import("../src/lib/polish.ts");
const { run, get } = await import("../src/lib/db.ts");
const { addDays, sgToday } = await import("../src/lib/dates.ts");

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (n: number) => { const [, m, d] = addDays(sgToday(), n).split("-"); return `${+d} ${MON[+m - 1]}`; };

let booth: number;
let n = 9800_0000;
const phone = () => `+65 ${++n}`;
before(() => {
  booth = createAccount({ email: "pol@test.sg", password: "password1", name: "Mel", business: "Snap & Smile", kind: "photobooth" }).vendorId;
  const base = { kind: "package" as const, pricing: "flat" as const, description: "", min_pax: null, max_pax: null };
  addItems(booth, [
    { ...base, name: "Classic Booth 3h", price: 850, included_hours: 3, extra_hour_price: 180 },
    { ...base, name: "Classic Booth 4h", price: 1050, included_hours: 4, extra_hour_price: 180 },
    { ...base, kind: "addon", name: "Guestbook album", price: 150, included_hours: null, extra_hour_price: null },
  ]);
  run("UPDATE vendors SET deposit_note = '30% deposit secures the date, balance 7 days before. PayNow to UEN 2023xxxxxK.', hold_hours = 48 WHERE id = ?", booth);
});

async function quote(text: string) {
  const { enquiryId } = E.ingest({ vendorId: booth, channel: "whatsapp", handle: phone(), name: "Sarah", text });
  await E.processEnquiry(booth, enquiryId);
  return { id: enquiryId, draft: E.pendingDraft(enquiryId)!, e: E.getEnquiry(booth, enquiryId)! };
}

test("deposit: the amount in whole dollars, from the setting or the % in the instructions", () => {
  const v = { deposit_pct: null, deposit_note: "30% deposit secures the date, balance 7 days before." };
  assert.deepEqual(P.depositLine(v, 1000), { amount: 300, pct: 30, text: "A deposit of SGD 300 (30%) secures the date, balance due 7 days before." });
  assert.equal(P.depositLine(v, 1111)!.amount, 333, "333.30 rounds to 333");
  assert.equal(P.depositLine(v, 1115)!.amount, 335, "334.50 rounds up");
  assert.equal(P.depositLine({ deposit_pct: 50, deposit_note: "30% via PayNow" }, 1200)!.text, "A deposit of SGD 600 (50%) secures the date.", "the setting wins");
  assert.equal(P.depositLine({ deposit_pct: null, deposit_note: "PayNow to UEN 123" }, 1200), null, "no % anywhere: no deposit line");
});

test("hold deadline: on the hour, Singapore time, and the text matches the stored hold", async () => {
  assert.equal(P.formatHoldTime("2026-11-01T08:00:00.000Z"), "Sun 1 Nov, 4pm");
  assert.equal(P.formatHoldTime("2026-11-01T08:30:00.000Z"), "Sun 1 Nov, 4:30pm");
  assert.equal(P.holdUntil("2026-10-30T07:47:12.000Z", 48), "2026-11-01T08:00:00.000Z");

  const { id, draft } = await quote(`Wedding on ${day(30)} evening, 120 guests, 3 hours, with the guestbook`);
  const m = get<{ hold_until: string }>("SELECT hold_until FROM messages WHERE id = ?", draft.id)!;
  assert.ok(draft.body.includes(`I'm holding the date for you until ${P.formatHoldTime(m.hold_until)}.`));
  E.markDraftSentManually(booth, draft.id);
  const hold = get<{ expires_at: string }>("SELECT expires_at FROM holds WHERE enquiry_id = ? AND status = 'active'", id)!;
  assert.equal(hold.expires_at, m.hold_until, "the hold ends exactly when the reply said");
});

test("a quote approved after its promised time gets a new deadline, in the hold and the text", async () => {
  const { id, draft } = await quote(`Party on ${day(31)} evening, 60 guests, 3 hours`);
  const old = new Date(Date.now() - 3600_000).toISOString();
  run("UPDATE messages SET hold_until = ?, body = ? WHERE id = ?", old, draft.body.replace(/I'm holding the date for you until [^.]+\./, P.holdSentence(old)), draft.id);
  E.markDraftSentManually(booth, draft.id);
  const sent = get<{ body: string }>("SELECT body FROM messages WHERE id = ?", draft.id)!.body;
  const hold = get<{ expires_at: string }>("SELECT expires_at FROM holds WHERE enquiry_id = ? AND status = 'active'", id)!;
  assert.ok(hold.expires_at > new Date().toISOString());
  assert.ok(sent.includes(P.holdSentence(hold.expires_at)), "the sent text names the real deadline");
  assert.ok(!sent.includes(P.holdSentence(old)));
});

test("the quote draft: deposit amount, a bigger package's full total with the add-ons, and a blank line before Total", async () => {
  const { draft, e } = await quote(`Wedding on ${day(32)} evening, 120 guests, 3 hours, with the guestbook`);
  const q = E.parseQuote(e)!;
  assert.equal(q.total, 850 + 150);
  assert.match(draft.body, /• Guestbook album: SGD 150\n\nTotal: SGD 1,000/);
  assert.match(draft.body, /Want more time\? Classic Booth 4h with the guestbook album is SGD 1,200\./, "4h 1050 + guestbook 150");
  assert.match(draft.body, /A deposit of SGD 300 \(30%\) secures the date, balance due 7 days before\./);
});

test("line breaks: 'Total' never sticks to the last line, whatever wrote the draft", () => {
  assert.equal(P.normalizeReply("• Guestbook: SGD 150Total: SGD 1000"), "• Guestbook: SGD 150\n\nTotal: SGD 1000");
  assert.equal(P.normalizeReply("• Guestbook: SGD 150\nTotal: SGD 1000"), "• Guestbook: SGD 150\n\nTotal: SGD 1000");
  assert.equal(P.normalizeReply("• Guestbook: SGD 150\n\nTotal: SGD 1000"), "• Guestbook: SGD 150\n\nTotal: SGD 1000");
  assert.equal(P.normalizeReply("• A: SGD 1\n**Total:** SGD 2"), "• A: SGD 1\n\n**Total:** SGD 2");
  assert.equal(P.normalizeReply("Subtotal: SGD 5"), "Subtotal: SGD 5");
});
