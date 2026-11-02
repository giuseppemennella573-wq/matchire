# Matchire positioning (source of truth for site copy)

## One-liner
Matchire is the AI booking desk for event vendors in Singapore: it answers every WhatsApp and email enquiry with a real price in minutes, follows up, and turns overflow into referral income through a partner network.

## Who we sell to (beachhead)
Primary: photobooth owner-operators in Singapore (price-shopped, quote-driven, often busy mid-event).
Secondary (keep on the site but don't lead with): venues, caterers, AV, décor, emcees.

## What we sell: outcomes, not features
1. More bookings from enquiries you already get (speed wins: the first real price usually wins).
2. Extra income from enquiries you can't take (refer to partners, earn a referral fee).
3. Time back: no more replying at 11pm.
Features (quotes, holds, follow-ups, off-peak) are proof points under these outcomes, never the headline.

## Moat to emphasise
The Match partner network: bundles and referrals. A generic WhatsApp bot can't copy it. Present it as a source of income, not a nice-to-have.

## Tone
Plain, warm, confident. Singapore English and SGD. Short sentences. No hype words ("revolutionary", "cutting-edge"). Never invent numbers, testimonials or logos.

## Hard rules
- No fake social proof. Proof sections stay hidden until we have real data.
- Any ROI number shown must be labelled as an estimate and computed from the visitor's own inputs.
- Do not change prices, plan limits, trial length or the early-access offer without Giuseppe's sign-off.
- Keep the early-access form (/api/early-access) and its field names working exactly as they are.
- Every feature claim on the site must match the product today. If a feature is not fully built, label it "Coming soon" or remove it. Keep the table below updated whenever a feature ships.

## Feature status (update when things ship)
| Feature | Status | Site wording |
|---|---|---|
| Quotes from your packages | Live | Claim freely |
| Date holds (auto-release) | Live | Claim freely |
| Referrals (pass on, fee tracked) | Live, basic | Claim pass-on + tracked fee. Don't claim payouts. |
| Bundle quotes | Partly built | "Your reply can suggest partner vendors, who can quote the planner directly." A starting price only if that partner shares it. No "combined/already priced quote". |
| Rate privacy | Live | Each vendor's rates are private to their account. Partners only see name and category, plus one starting price if the vendor turns on "Share my starting price with partners" (off by default). Never the full rate card. |
| Automatic follow-ups | Live on email and WhatsApp (WhatsApp follow-ups after 24h need the vendor's templates approved in Meta) | Claim it |
| Instagram DMs | Not built | Coming soon |
| Multiple users / team logins | Not built | Coming soon |
| Equipment stock (availability per booth type) | Live | "Knows what's free: if your 360 booth is booked that day but a Classic booth isn't, Matchire offers the Classic with its real price, your nearest free 360 dates, or a partner." Site wording pending Giuseppe's approval (Pack 08). Per day only; never claim time slots or per-room scheduling. |
| Multiple rooms, spaces or brands | Equipment per booth type is Live (see above); rooms, spaces, brands and time slots not built | Rooms, brands, time slots: coming soon |
| Spreadsheet rate-card upload | Not built (PDF, photo, text work) | List PDF, photo, text; spreadsheet = coming soon |
| Connect existing WhatsApp number | Assisted setup, not self-serve | "We set it up with you" |
| Email inbox | Assisted setup | "We set it up with you" |
| "Replies are assisted" note | No setting | Say "add it to your sign-off" |
| Billing / plan limits / trial | Not enforced (early access) | OK to show plans; free during early access |
| Qualify before quoting | Live | Site (features card "Asks before it quotes", timeline, demo, FAQ): "No price goes out until Matchire knows the date and one more detail, like guest count or venue. Price-shoppers get questions, real clients get an exact quote." |
| Price-fishing flag | Live | Site (card "Spots price-fishers", FAQ "What if someone is just collecting prices?"): "Enquiries that keep asking for the full price list without giving a date get flagged, and prices stop going out automatically." Never say we accuse or block clients. |
| Brief mode (custom services) | Live | Site (card "Brief mode for custom work", FAQ "My services are custom…", approved by Giuseppe): "Matchire asks the right questions, holds the date and sends you a clean brief. You write the quote." |
| Date unavailable: other dates + partner | Live | Site (card "Date taken? Keep the lead", network line): "If you're booked, Matchire offers your nearest free dates and can suggest a trusted partner." Partner price only if that partner shares it. |
| Per-package extra-hour rates | Live | Site (card "Exact quotes from your packages", FAQ "What if it quotes the wrong price?"): "Each package can have its own extra-hour rate, so longer events are priced correctly." Every quote states the deposit in SGD and when the hold ends. |
| "Not sure yet" / "Too expensive" keep the lead open (Undecided / Price concern) | Live | "Knows 'maybe' from 'no': 'Not sure yet' keeps the date held and follow-ups running. 'Too expensive' comes to you with real options from your price list, never an invented discount." Only clear refusals close an enquiry. |
| Vendor data privacy (encrypted backups, logged support access) | Live | Site (first FAQ "Can Matchire see my prices?", approved by Giuseppe): "Other vendors never see your prices. We only look at your account if you ask us to, and if we do, it shows up in your own access log. Our backups are encrypted." Backups are AES-256 encrypted; staff open an account only through the read-only, 30-minute, logged Support view, and the vendor sees every visit in Settings → Account. Never say "nobody can ever see your data" (Render hosts it; Anthropic processes it to draft replies). |
| Learns your writing style from your replies | Live | Site (card "Sounds like you"): "Matchire learns from the replies you write yourself, so its drafts sound like you, not a bot. Prices, dates and client details are taken out first, and your words are never used for anyone else." No model training; never say it "trains on" or "studies" the vendor's data. |
| Recognises regular clients | Live | Site (card "Remembers your regulars"): "When a past client messages you again on WhatsApp or email, you see it straight away: what they booked and when. The reply welcomes them back." The reply never mentions past bookings or prices. |

## Open decisions (ask Giuseppe before acting)
- None right now.

## Decision log
- 2026-10-27: Shift messaging from speed/features to revenue + partner network. Photobooths as beachhead.
- 2026-10-27: Referrals included on all plans (Giuseppe approved).
- 2026-10-28: "14-day free trial" replaced with "Free during early access" on the site; prices unchanged (Giuseppe approved).
- 2026-10-28: Guarantee, shown under the pricing note: "Our guarantee: when paid plans start, if Matchire doesn't win you a booking in your first 30 days, your next month is free." Applies only once paid plans start. No money-back guarantee. (Approved by Giuseppe, 2026-10-28.)
- 2026-10-28: Tagline "Match. Hire. Booked." in the footer under the name and in the page <title> after "Matchire.ai". The hero headline stays as it is. (Approved by Giuseppe, 2026-10-28.)
- 2026-10-28: Venue plan adds "Partner suggestions in replies", just above "Send & receive partner referrals". (Approved by Giuseppe, 2026-10-28.)
- 2026-10-28: Rates are private per business. "Share my starting price with partners" setting, default off (existing accounts off too); when on, partners see one "from" price, never the rate card. Partner suggestions without it read "Our partner X (category) can quote you directly." Site copy no longer promises partner prices. (Approved by Giuseppe, 2026-10-28.)
- 2026-10-28: Nav button "Start free trial" renamed "Join early access" to match the pricing note; no "trial" wording left on the site. (Approved by Giuseppe, 2026-10-28.)
- 2026-10-30: Pack 04. No price (total, range or "from" price) goes to a planner until Matchire knows the event date plus one more detail (guests, venue, hours or event type), unless the vendor chooses "Send price anyway". (Approved by Giuseppe, 2026-10-30.)
- 2026-10-30: Pack 05. Landing page shows Pack 04 features; Brief-mode and price-fishing FAQ added (approved by Giuseppe).
- 2026-11-01: Pack 06. Vendor data privacy is a key feature: 'Can Matchire see my prices?' is the first FAQ on the landing page (approved by Giuseppe).
- 2026-11-02: Pack 07. New feature row "Knows your business" (Sounds like you, Remembers your regulars, Your prices stay yours) and the "New in early access" strip updated; Privacy Policy names the vendor's cleaned earlier replies sent to Anthropic (approved by Giuseppe).
- 2026-11-02: Pack 08. Availability is per equipment (Print booth × 6, 360 booth × 2), with "Most jobs in one day" as an optional cap. Key for photobooth businesses with mixed booths (Giuseppe). Landing page wording to be approved separately.
