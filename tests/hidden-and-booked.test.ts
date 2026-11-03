import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-hb-")), "test.db");
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "SMTP_HOST", "RESEND_API_KEY"]) delete process.env[k];

const { createAccount } = await import("../src/lib/accounts.ts");
const C = await import("../src/lib/contacts.ts");
const E = await import("../src/lib/engine.ts");
const { run, get, all } = await import("../src/lib/db.ts");
const { addDays, sgToday } = await import("../src/lib/dates.ts");

let v: number, other: number;
before(() => {
  v = createAccount({ email: "mel@snap.sg", password: "password1", name: "Mel", business: "Snap Co", kind: "photobooth", samplePrices: true }).vendorId;
  other = createAccount({ email: "o@x.sg", password: "password1", name: "O", business: "O Co", kind: "photobooth" }).vendorId;
});

test("contact keys match the same number however it's written, and emails in any case", () => {
  assert.equal(C.contactKey("+65 9123 4501"), "6591234501");
  assert.equal(C.contactKey("9123-4501"), "6591234501");
  assert.equal(C.contactKey("Mel@Snap.SG"), "mel@snap.sg");
  assert.equal(C.contactKey("  "), null);
});

test("a hidden contact's messages are dropped and only counted; showing them again lets them through", () => {
  const r = C.setRule(v, "+65 9888 7777", "hidden");
  assert.equal(C.dropIfHidden(v, "+6598887777"), true);
  assert.equal(C.dropIfHidden(v, "98887777"), true);
  assert.equal(C.dropIfHidden(other, "+6598887777"), false, "one vendor's rule only");
  assert.equal(C.dropIfHidden(v, "+65 9000 0000"), false);
  assert.equal(C.listRules(v, "hidden")[0].hidden_count, 2);
  assert.equal(get<{ n: number }>("SELECT COUNT(*) n FROM enquiries WHERE contact_handle LIKE '%9888%'")!.n, 0, "nothing stored");
  C.removeRule(v, r.id);
  assert.equal(C.dropIfHidden(v, "+6598887777"), false);
});

test("both webhooks drop hidden contacts before anything is stored or read", () => {
  for (const f of ["src/app/api/webhooks/whatsapp/route.ts", "src/app/api/webhooks/email/[token]/route.ts"]) {
    const src = readFileSync(f, "utf8");
    const drop = src.indexOf("dropIfHidden(vendor.id");
    assert.ok(drop > 0, `${f} checks hidden contacts`);
    assert.ok(drop < src.indexOf("ingest({"), `${f}: before ingest`);
    if (f.includes("email")) assert.ok(drop < src.indexOf("fileAsOther("), "before filing too");
  }
});

test("'Never show messages from this number' hides the contact and files the conversation", async () => {
  const { enquiryId } = E.ingest({ vendorId: v, channel: "whatsapp", text: "Bro dinner later?", name: "Ah Kow", handle: "+65 9111 2222" });
  await E.processEnquiry(v, enquiryId);
  assert.ok(E.pendingDraft(enquiryId));
  E.hideContact(v, enquiryId);
  const e = E.getEnquiry(v, enquiryId)!;
  assert.deepEqual([e.status, e.filed_reason], ["other", "Hidden contact"]);
  assert.equal(E.pendingDraft(enquiryId), undefined);
  assert.equal(C.dropIfHidden(v, "+6591112222"), true);
});

test("a booked client's 'see you Saturday!' joins the booking, with no sales draft", async () => {
  const date = addDays(sgToday(), 10);
  const booking = run(
    "INSERT INTO enquiries (vendor_id, channel, contact_name, contact_handle, status, event_date, won_value) VALUES (?, 'whatsapp', 'Rachel', '+65 9345 6789', 'won', ?, 1200)",
    v, date,
  );
  const { enquiryId } = E.ingest({ vendorId: v, channel: "whatsapp", text: "Hi Mel! See you Saturday 😊 can we start at 6:30pm?", handle: "+65 9345 6789" });
  assert.equal(enquiryId, booking, "joins the booking");
  const r = await E.processEnquiry(v, enquiryId);
  assert.equal(r.draftId, null);
  assert.equal(E.pendingDraft(enquiryId), undefined, "no sales reply");
  assert.match(E.getEnquiry(v, enquiryId)!.owner_reason ?? "", /Message from a booked client/);
  assert.equal(E.getEnquiry(v, enquiryId)!.status, "won");
  // The vendor can still ask for a draft.
  await E.processEnquiry(v, enquiryId, { force: true });
  assert.ok(E.pendingDraft(enquiryId), "a draft on request");
});

test("a booked client asking about a different date starts a new enquiry", async () => {
  const date = addDays(sgToday(), 12);
  const booking = run(
    "INSERT INTO enquiries (vendor_id, channel, contact_name, contact_handle, status, event_date) VALUES (?, 'whatsapp', 'Jo', '+65 9456 7890', 'won', ?)",
    v, date,
  );
  const target = new Date(addDays(sgToday(), 60) + "T00:00:00Z").toLocaleDateString("en-SG", { day: "numeric", month: "long", timeZone: "UTC" });
  const { enquiryId } = E.ingest({ vendorId: v, channel: "whatsapp", text: `Hi! Loved it last time. Could we book the booth again on ${target}, 3 hours, 80 guests?`, handle: "+65 9456 7890" });
  assert.equal(enquiryId, booking);
  const r = await E.processEnquiry(v, enquiryId);
  assert.notEqual(r.enquiryId, booking, "moved to a new enquiry");
  assert.equal(E.getEnquiry(v, r.enquiryId)!.status, "new");
  assert.ok(E.pendingDraft(r.enquiryId));
  assert.equal(all("SELECT id FROM messages WHERE enquiry_id = ? AND direction = 'in'", booking).length, 0, "the booking keeps its own history");
});

test("a booking long past doesn't capture new messages", () => {
  run("INSERT INTO enquiries (vendor_id, channel, contact_handle, status, event_date) VALUES (?, 'whatsapp', '+65 9567 8901', 'won', ?)", v, addDays(sgToday(), -30));
  const { isNew } = E.ingest({ vendorId: v, channel: "whatsapp", text: "Hi again!", handle: "+65 9567 8901" });
  assert.equal(isNew, true);
});

test("a booked client's message counts as needing the vendor until it's handled or answered", () => {
  const layout = readFileSync("src/app/app/layout.tsx", "utf8");
  const inbox = readFileSync("src/app/app/inbox/page.tsx", "utf8");
  assert.match(layout, /e\.status = 'won' AND e\.owner_reason LIKE 'Message from a booked client%'/, "in the 'needs you' badge");
  assert.match(inbox, /filter === "attention" \? `AND \(EXISTS .+ OR \$\{BOOKED_WROTE\}\)`/, "in Needs you");
  assert.match(readFileSync("src/app/app/actions.ts", "utf8"), /intent === "handled"\) run\("UPDATE enquiries SET owner_reason = NULL/);
});
