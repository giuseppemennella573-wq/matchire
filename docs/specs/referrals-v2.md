# Referrals v2: accept, alert, agreed fee, mark paid

**Status:** spec, not built. **Builds on:** the existing flow (Pass to a partner → enquiry copied into the partner's inbox → fee calculated when the partner marks it booked). This spec covers only the four gaps below.

## Today, and why it changes
`referToPartner()` immediately creates the enquiry in the partner's inbox, copies the planner's name, contact details and messages, and drafts a reply (which goes out on its own if the partner has auto-send on). The fee % is the **referrer's** setting. So a partner can receive a planner's details they never agreed to take, and fees are not agreed. v2 puts an offer step in front and moves the fee onto the partnership.

## 1. Accept / decline
- **Pass to a partner** now creates a referral with status **`offered`**. No enquiry is created for the partner yet, and **no contact details or messages are shared**. The partner sees only a summary: event date, event type, guest count, budget, location, and the referrer's name.
- **Accept** → the existing copy step runs (the enquiry is created in their inbox, the reply is drafted), and the status becomes **`accepted`**. The referrer's enquiry becomes **Referred**, and the "let the planner know" draft appears for them (as today).
- **Decline** (optional reason) → status **`declined`**. The referrer's enquiry goes back to open with a note: "Declined by X: reason". The referrer can pass it to someone else.
- **No answer in 4 hours** → the referrer is notified ("X hasn't answered"). The offer stays open until the referrer **withdraws** it (status **`withdrawn`**) or offers it elsewhere, which withdraws the first offer automatically.
- **One live offer per enquiry.** An offer also expires automatically when the event date passes.
- **Where:** the partner sees offers at the top of their **Inbox** ("Offered to you") and on **Partners**. The referrer sees the offer state on the enquiry page, in the existing "Pass to a partner" card.

## 2. Alert to the partner
When a referral is offered:
- **Email:** "X offered you an enquiry: Sat 15 Nov · wedding · 120 guests · budget S$3,000", with **Accept** and **Decline** buttons (signed links to `/app/referrals/{id}?action=…`; login required).
- **WhatsApp:** a template message (category UTILITY, name `referral_offer`) to the partner's notification number, with the same summary and a link. This needs a new vendor setting, **Notify me on WhatsApp at**, and the template approved in Meta. If either is missing, email only.
- The referrer is notified on accept, on decline, and at the 4-hour mark: in-app, plus email.

## 3. Fee agreed per partnership
- When a partnership is accepted, it carries a **proposed fee %** (default 10%, proposed by the inviter). The other side must **Confirm** it. Until it's confirmed, neither side can offer referrals ("Agree the fee with X first").
- **One % per partnership, used in both directions:** whoever receives a referral pays the referrer that % of the booking value.
- **Either side can propose a change.** It needs the other side's confirmation and applies to **new offers only**. Each referral stores the % at the moment it was offered.
- The referrer's per-vendor fee setting in Settings becomes just the default % for new invites.

## 4. Mark as paid
- When the partner marks the booking won, the referral fee becomes **`owed`** (amount = booking value × the referral's stored %, as today).
- The **partner** (payer) taps **Mark paid** → `paid_marked`. The **referrer** taps **Confirm received** → `paid`. Either side can add a note (e.g. "PayNow 3 Nov").
- **Partners page:** each booked referral shows Owed / Marked paid / Paid, plus running totals of **owed to you** and **you owe**, per partner and overall.
- No payment processing. Matchire only records what partners tell it.

## Data model
- `partnerships`: add `fee_pct REAL`, `fee_proposed_pct REAL`, `fee_proposed_by INTEGER`, `fee_confirmed_at TEXT`.
- `referrals`:
  - `status` becomes `offered | accepted | declined | withdrawn | expired | won | lost`. Existing rows migrate `open` → `accepted`.
  - `target_enquiry` becomes **nullable**, set on accept.
  - Add `summary TEXT` (JSON of the shared fields), `decline_reason TEXT`, `offered_at`, `responded_at`, `reminded_at`.
  - Add `fee_status TEXT` (`none | owed | paid_marked | paid | void`), `paid_marked_at`, `paid_confirmed_at`, `payment_note TEXT`.
- `vendors`: add `notify_whatsapp TEXT`.
- Change both enquiry foreign keys on `referrals` from `ON DELETE CASCADE` to `ON DELETE SET NULL`, so deleting an enquiry never erases a fee record.

## Edge cases
- **Partner gives it back after accepting** (before booking): **Return to referrer** → status `declined`, with the reason. The partner's copy is closed. Not allowed once it's booked.
- **Booking cancelled after won:** the partner marks it lost → `fee_status` becomes `void` if not yet paid. If it was already paid, flag it as "Refund to settle between you". No automation.
- **Partnership removed:** open offers are withdrawn. Accepted and owed referrals stay visible, and their fees can still be marked paid.
- **Enquiry deleted** by either side: the referral and its fee stay (see the FK change), shown as "enquiry deleted".
- **Fee change pending while an offer is out:** the offer keeps the % it was offered with.
- **Same planner already in the partner's inbox:** on accept, the copy joins their existing conversation (current `ingest` behaviour), and the referral still links to it.

## Not building
Payouts or collecting money, invoices or receipts, Matchire taking a commission, dispute handling, different fees per referral or per direction, partner ratings or ranking, offering to several partners at once, and non-SGD amounts.
