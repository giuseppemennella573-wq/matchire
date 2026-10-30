import type { Details } from "./types.ts";
import { asksPrice, hasField } from "./qualify.ts";

// Spotting price-fishing: a competitor or bargain hunter collecting prices with
// no real event behind the enquiry. A flagged enquiry never gets a price sent
// on its own (even with auto-send on); the vendor checks each reply, and can
// clear the flag with one click. The planner is never told.

export type FishingSignal = "price_asks" | "dodged_date" | "full_list" | "repeat_contact";

export interface FishingInput {
  /** The planner's messages, oldest first. */
  inbound: string[];
  /** How many of the planner's messages came after we'd asked for the date. */
  repliesAfterDateAsk: number;
  details: Details;
  /** What the first message alone told us. */
  firstDetails: Details;
  /** This contact's enquiries in the last 30 days, this one included: their event dates. */
  recentDates: (string | null)[];
}

const FULL_LIST = /\b(full|whole|complete|entire)\s+(package|price|rate)s?\s*(list|card|sheet)?\b|\ball\s+(your|the)\s+(prices|packages|rates)\b|\b(rate\s*card|price\s*list|pricelist)\b/i;

/** The first signal that fits, with a reason the vendor can read, or null. */
export function fishingSignal(x: FishingInput): { signal: FishingSignal; reason: string } | null {
  const noDate = !hasField(x.details, "date");
  const priceAsks = x.inbound.filter(asksPrice).length;
  if (noDate && priceAsks >= 2) return { signal: "price_asks", reason: `asked for prices ${priceAsks} times without giving a date` };
  if (noDate && x.repliesAfterDateAsk >= 2) return { signal: "dodged_date", reason: "replied twice without giving the event date" };
  const f = x.firstDetails;
  const noEvent = !hasField(f, "date") && !f.pax && !f.event_type && !f.hours && !f.location;
  if (x.inbound[0] && FULL_LIST.test(x.inbound[0]) && noEvent) return { signal: "full_list", reason: "asked for the full price list in the first message, with no event details" };
  const dates = x.recentDates;
  if (dates.length >= 3 && (dates.some((d) => !d) || new Set(dates).size > 1)) {
    return { signal: "repeat_contact", reason: `${dates.length} enquiries from this contact in 30 days, with different or no dates` };
  }
  return null;
}
