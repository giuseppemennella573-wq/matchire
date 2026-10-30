import { all, get, run, tx } from "./db.ts";
import { addItems, createAccount, token } from "./accounts.ts";
import { ingest, processEnquiry } from "./engine.ts";
import { addDays, dayOfWeek, sgToday } from "./dates.ts";
import type { Item } from "./types.ts";

// The demo workspace we show prospects: Snap & Smile Photobooth with a partner
// caterer and a partner photobooth (who shares their starting price, for the
// date-clash referral), a fully booked Saturday and three enquiries drafted by
// the normal pipeline. Both accounts are is_demo, so nothing they do is ever really sent
// (see deliver() in channels.ts). Seeding resets them: running it twice gives
// the same result.

export const DEMO_EMAIL = "demo@matchire.ai";
export const DEMO_PARTNER_EMAIL = "rempah-demo@matchire.ai";
export const DEMO_BOOTH_PARTNER_EMAIL = "snapbox-demo@matchire.ai";
export const DEMO_EMAILS = [DEMO_EMAIL, DEMO_PARTNER_EMAIL, DEMO_BOOTH_PARTNER_EMAIL];

type NewItem = Omit<Item, "id" | "vendor_id" | "active" | "sort">;
const item = (o: Partial<NewItem> & Pick<NewItem, "kind" | "name" | "pricing" | "price">): NewItem => ({
  description: "", included_hours: null, extra_hour_price: null, min_pax: null, max_pax: null, ...o,
});
const CLASSIC = "Unlimited prints, props and an attendant";

// Every package has its own extra-hour rate, so 3.5h or 5h can be quoted.
const PRICE_LIST: NewItem[] = [
  item({ kind: "package", name: "Classic Booth 2h", pricing: "flat", price: 650, included_hours: 2, extra_hour_price: 180, description: CLASSIC }),
  item({ kind: "package", name: "Classic Booth 3h", pricing: "flat", price: 850, included_hours: 3, extra_hour_price: 180, description: CLASSIC }),
  item({ kind: "package", name: "Classic Booth 4h", pricing: "flat", price: 1050, included_hours: 4, extra_hour_price: 180, description: CLASSIC }),
  item({ kind: "package", name: "360 Video Booth 3h", pricing: "flat", price: 1200, included_hours: 3, extra_hour_price: 350, description: "Slow-motion 360 videos, shared instantly" }),
  item({ kind: "addon", name: "Custom backdrop", pricing: "flat", price: 120 }),
  item({ kind: "addon", name: "Guestbook album", pricing: "flat", price: 150 }),
  item({ kind: "addon", name: "Digital gallery + GIFs", pricing: "flat", price: 90 }),
  item({ kind: "addon", name: "Second print station", pricing: "flat", price: 250 }),
];

const NOTES =
  "We need a 2m x 3m space and one power socket. Setup takes 45 minutes before start time. 30% deposit secures the date, balance 7 days before. " +
  "Travel to Sentosa or Jurong Island: +S$80. We don't do events past midnight.";

/** The first Saturday on or after `from` days from today (Singapore time). */
export function saturdayFrom(days: number, today = sgToday()): string {
  let d = addDays(today, days);
  while (dayOfWeek(d) !== 6) d = addDays(d, 1);
  return d;
}

const longDate = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-SG", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/** Delete the demo accounts, refusing to touch a real account that happens to use a demo email. */
function removeDemoAccounts() {
  for (const email of DEMO_EMAILS) {
    const v = get<{ vendor_id: number; is_demo: number }>(
      "SELECT u.vendor_id, v.is_demo FROM users u JOIN vendors v ON v.id = u.vendor_id WHERE u.email = ?", email,
    );
    if (!v) continue;
    if (!v.is_demo) throw new Error(`${email} belongs to a real (non-demo) account, so the demo wasn't reset. Move that account to another email first.`);
    tx(() => {
      run("UPDATE enquiries SET referred_from = NULL WHERE referred_from = ?", v.vendor_id);
      run("DELETE FROM vendors WHERE id = ?", v.vendor_id);
    });
  }
}

let seeding = false;

export async function seedDemo(password = process.env.DEMO_PASSWORD, now = new Date()) {
  if (!password || password.length < 8) throw new Error("Set DEMO_PASSWORD (at least 8 characters) before seeding the demo.");
  if (seeding) throw new Error("The demo is already being reset. Wait a minute and refresh.");
  seeding = true;
  try {
    removeDemoAccounts();
    const today = sgToday(now);

    const booth = createAccount({ email: DEMO_EMAIL, password, name: "Mel", business: "Snap & Smile Photobooth", kind: "photobooth" }).vendorId;
    run(
      `UPDATE vendors SET is_demo = 1, auto_send = 0, tone = ?, signoff = ?, notes = ?, deposit_note = ?, hold_hours = 48, followup_days = 2,
       jobs_per_day = 2, min_spend = 650, offpeak_discount = 10, bundle_suggestions = 1, share_from_price = 0, referral_fee_pct = 10 WHERE id = ?`,
      "Friendly, upbeat, short replies.", "Mel @ Snap & Smile", NOTES, "30% deposit secures the date, balance 7 days before.", booth,
    );
    addItems(booth, PRICE_LIST);

    // The partner never logs in: a random password nobody knows.
    const kitchen = createAccount({ email: DEMO_PARTNER_EMAIL, password: token(24), name: "Siti", business: "Rempah Kitchen", kind: "caterer" }).vendorId;
    run("UPDATE vendors SET is_demo = 1, auto_send = 0, share_from_price = 0 WHERE id = ?", kitchen);
    addItems(kitchen, [item({ kind: "package", name: "Buffet", pricing: "per_pax", price: 16, min_pax: 50, description: "Local favourites, halal-certified kitchen" })]);
    run("INSERT INTO partnerships (requester_id, partner_id, status) VALUES (?, ?, 'accepted')", booth, kitchen);

    // A partner photobooth who shares their starting price (SGD 450, as on the landing page): offered when Snap & Smile is booked.
    const snapbox = createAccount({ email: DEMO_BOOTH_PARTNER_EMAIL, password: token(24), name: "Ana", business: "Snapbox SG", kind: "photobooth" }).vendorId;
    run("UPDATE vendors SET is_demo = 1, auto_send = 0, share_from_price = 1 WHERE id = ?", snapbox);
    addItems(snapbox, [item({ kind: "package", name: "Classic booth 2h", pricing: "flat", price: 450, included_hours: 2, extra_hour_price: 120, description: "Unlimited prints, props and an attendant" })]);
    run("INSERT INTO partnerships (requester_id, partner_id, status) VALUES (?, ?, 'accepted')", booth, snapbox);

    // A fully booked Saturday (2 jobs a day, so two bookings).
    const booked = saturdayFrom(21, today);
    run("INSERT INTO holds (vendor_id, date, kind, note) VALUES (?, ?, 'booking', 'Lim family party (afternoon)')", booth, booked);
    run("INSERT INTO holds (vendor_id, date, kind, note) VALUES (?, ?, 'booking', 'Tan & Ong wedding (evening)')", booth, booked);
    const wedding = saturdayFrom(35, today);

    const enquiries = [
      { channel: "whatsapp" as const, name: "Sarah Tan", handle: "+65 9123 4501", email: null,
        text: `Hi! Wedding on ${longDate(wedding)}, 7pm-11pm at Raffles Hotel, about 150 guests. Do you have 3h with a guestbook? How much?` },
      { channel: "instagram" as const, name: "Kelly", handle: "@kellylim.sg", email: null, text: "hi how much for photobooth" },
      { channel: "email" as const, name: "Daniel Koh", handle: "daniel.koh@bluewave.sg", email: "daniel.koh@bluewave.sg",
        text: `Corporate D&D\n\nHi Snap & Smile, we're organising our company D&D on ${longDate(booked)}, 6pm to 9pm at Marina Bay, around 300 pax. We'd like the 360 booth. Could you send us a quote?\n\nThanks,\nDaniel Koh, Bluewave Pte Ltd` },
    ];
    // The normal intake and drafting pipeline. Auto-send is off and the account is a demo, so nothing is sent.
    for (const q of enquiries) {
      const { enquiryId } = ingest({ vendorId: booth, channel: q.channel, text: q.text, name: q.name, handle: q.handle, email: q.email });
      await processEnquiry(booth, enquiryId);
    }

    return {
      vendorId: booth,
      partnerId: kitchen,
      boothPartnerId: snapbox,
      bookedSaturday: booked,
      weddingSaturday: wedding,
      enquiries: all<{ id: number }>("SELECT id FROM enquiries WHERE vendor_id = ?", booth).length,
    };
  } finally {
    seeding = false;
  }
}
