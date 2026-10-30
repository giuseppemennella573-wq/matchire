// Creates a demo workspace: Snapbox SG (photobooth) with three partner vendors
// and a handful of realistic enquiries at different stages.
//   npm run seed            → dev@matchire.ai / matchire-demo  (local development only)
// The demo we show prospects is separate: npm run seed:demo (scripts/seed-demo.ts).
import { get, run } from "../src/lib/db.ts";
import { createAccount } from "../src/lib/accounts.ts";
import * as E from "../src/lib/engine.ts";
import { addDays, formatDate, sgToday } from "../src/lib/dates.ts";

if (get("SELECT 1 FROM users WHERE email = 'dev@matchire.ai'")) {
  console.log("Demo data already exists. Delete data/matchire.db to start over.");
  process.exit(0);
}

const PASSWORD = "matchire-demo";
const booth = createAccount({ email: "dev@matchire.ai", password: PASSWORD, name: "Giuseppe", business: "Snapbox SG", kind: "photobooth", samplePrices: true }).vendorId;
const caterer = createAccount({ email: "rempah@matchire.ai", password: PASSWORD, name: "Siti", business: "Rempah Kitchen", kind: "caterer", samplePrices: true }).vendorId;
const venue = createAccount({ email: "loft@matchire.ai", password: PASSWORD, name: "Marcus", business: "The Loft, Telok Ayer", kind: "venue", samplePrices: true }).vendorId;
const av = createAccount({ email: "clearwave@matchire.ai", password: PASSWORD, name: "Ravi", business: "Clearwave AV", kind: "av", samplePrices: true }).vendorId;

run(`UPDATE vendors SET notes = ?, deposit_note = ? WHERE id = ?`,
  "We cover all of Singapore; transport is a flat $60. Setup takes 45 minutes and needs a 2×2m space near a power point. Prints are 4R, unlimited.",
  "A 30% deposit via PayNow to UEN 202312345K secures your date. The balance is due on the day.", booth);
run(`UPDATE vendors SET notes = ? WHERE id = ?`, "Outside catering allowed. Venue is on level 2 with lift access. Capacity 60 standing.", venue);
for (const p of [caterer, venue]) run("INSERT INTO partnerships (requester_id, partner_id, status) VALUES (?, ?, 'accepted')", booth, p);
run("INSERT INTO partnerships (requester_id, partner_id, status) VALUES (?, ?, 'pending')", av, booth);

const today = sgToday();
const d = (n: number) => formatDate(addDays(today, n)).replace(/^\w+ /, ""); // "15 Nov"

const enquiries: { channel: "whatsapp" | "email" | "web" | "instagram"; name: string; handle: string; text: string; then?: "send" | "book" | "reply" }[] = [
  { channel: "whatsapp", name: "Mei Ling", handle: "+65 9123 4567", text: `Hi! Looking for a photobooth for my daughter's 21st on ${d(22)}, evening, about 80 guests. 3 hours. Do you do custom print frames? Budget around $900` },
  { channel: "email", name: "Daniel Koh", handle: "daniel.koh@acme.sg", text: `Hello, we're planning our corporate D&D at a hotel ballroom early ${formatDate(addDays(today, 40)).split(" ")[2]}, 250 pax. Interested in a 360 booth for 4 hrs. Can send quote?` },
  { channel: "whatsapp", name: "Priya", handle: "+65 8765 4321", text: `hey do u have availability on ${d(10)} afternoon? company family day, 2 hours`, then: "send" },
  { channel: "web", name: "Wei Jie & Hannah", handle: "+65 9001 2233", text: `Wedding solemnisation on ${d(35)} evening, 120 guests, 3 hours. Classic booth with a guestbook album please!`, then: "book" },
  { channel: "instagram", name: "Aisyah", handle: "@aisyah.events", text: `Hi! Booth for a baby shower ${d(16)} morning, 40 pax, 2 hours. Any discount on weekdays?`, then: "reply" },
];

for (const q of enquiries) {
  const { enquiryId } = E.ingest({ vendorId: booth, channel: q.channel, text: q.text, name: q.name, handle: q.handle, email: q.handle.includes("@") && !q.handle.startsWith("@") ? q.handle : null });
  await E.processEnquiry(booth, enquiryId);
  const draft = E.pendingDraft(enquiryId);
  if (!q.then || !draft) continue;
  E.markDraftSentManually(booth, draft.id);
  if (q.then === "book") E.markBooked(booth, enquiryId);
  if (q.then === "reply") {
    E.appendInbound(booth, enquiryId, "Sounds good! Let's go ahead. How do I pay the deposit?");
    await E.processEnquiry(booth, enquiryId);
  }
}
E.blockDate(booth, addDays(today, 22 + 7), "Away: family wedding");

console.log(`Demo ready. Log in at /login with dev@matchire.ai / ${PASSWORD}`);
console.log(`Partner accounts (same password): rempah@, loft@, clearwave@matchire.ai`);
