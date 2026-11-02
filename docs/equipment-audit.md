# Availability audit (Pack 08, step 1)

Today a vendor has one number, `vendors.jobs_per_day` (default 1), and a date is free when its active holds (holds, bookings and manual entries) are below that number. Nothing records which booth a hold uses.

## Storage

- `holds`: one row per hold, booking or block, with `vendor_id`, `enquiry_id` (null for manual entries), `date`, `kind` (`hold`/`booking`/`block`), `status`, `note`, `expires_at`.
- **Missing:** which equipment a hold uses, and how many units. **Change in this pack:** a `hold_equipment` table (hold, equipment, units) so one hold can take, say, a print booth plus a second print station.

## Where availability is used

| Place | Today | With equipment | Verdict |
|---|---|---|---|
| `availability()` (`engine.ts`) | Counts active holds on the date against `jobs_per_day`; a block closes the day | Checks the units of each piece of equipment the request needs, plus an optional day cap; a block still closes the day | Change in this pack |
| Quoting (`processEnquiry`): `dateBooked`, `available` | One answer for the whole day | Answer for the requested package's equipment | Change |
| "Date taken" (`alternativeDates`, partner suggestion) | Nearest free days; a same-category partner | Nearest days where *that equipment* is free; **plus** the vendor's own packages that are free that day, with real prices; partner as today | Change |
| Holds on send (`afterSend` quote and brief) | Inserts a hold if the day is free | Inserts the hold with the equipment it uses | Change |
| `markBooked` | Turns the hold into a booking, or inserts a booking | Same, keeping or adding the equipment | Change |
| Hold expiry, release, `markLost` | Status changes only | Unchanged: equipment rows follow the hold's status | Fine as is |
| Off-peak suggestion (`priceConcernOptions`) | Nearest weekday the day is free | The weekday where the package's equipment is free | Change |
| Downsell / upsell (`polish.ts`) | Any package on the price list | Only packages whose equipment is free that day | Change |
| Calendar page | Lists holds per day; header "You take N jobs a day"; block a date | Per-equipment counts per day; header names the equipment; add a booking made outside Matchire with its equipment | Change |
| Settings → Bookings: "Jobs you can take per day" | Required, at least 1 | "Most jobs in one day (optional)": empty means no day limit **only** for vendors with equipment | Change (step 5) |
| Demo seed | `jobs_per_day = 2`, a Saturday with 2 bookings, the Bluewave D&D (360 booth) hits it | Print booth × 3, 360 booth × 1; that Saturday has the 360 booked, so the D&D gets "360 taken, Classic free" | Change |
| Price-list import | Packages and add-ons only | Suggest equipment names from package families for the vendor to confirm; nothing linked automatically | Change |
| Follow-ups, Brief mode questions, price-fishing | Don't read availability | No change | Fine as is |
| Tests (`date-unavailable`, `engine`, `qualify`, `demo`, `settings-tabs`) | Assume the day counter | Vendors without equipment must pass unchanged; the demo test changes with the demo | Change only where the demo changes |

## Notes for later

- **Time slots.** The same booth doing a morning and an evening job isn't handled: availability stays per day.
- **Existing holds and bookings have no equipment.** For a vendor who adds equipment later, they still count toward the day cap but not toward any equipment. The calendar flags them so the vendor can assign equipment.
