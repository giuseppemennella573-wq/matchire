# Inbox filter audit (Pack 09, step 1)

## What happens to an incoming message today

| Channel | Path | Filtering today |
|---|---|---|
| WhatsApp (`api/webhooks/whatsapp`) | Meta webhook → signature check → text messages only (media, reactions and stickers skipped) → `ingest` (joins an open enquiry from the same number within 60 days, else a new one) → `processEnquiry` (AI or rules read, then a draft) | None. Every text message becomes an enquiry with a draft: friends, suppliers, booked clients. |
| Email (`api/webhooks/email/[token]`) | Postmark / Mailgun / SendGrid post → sender, subject and text read; quoted history stripped → `ingest` → `processEnquiry` | None. **Headers aren't read**, so out-of-office replies, newsletters and bounces become enquiries with drafts. |
| Website form (`e/[slug]`) | Form → honeypot field (bots) → `ingest` → `processEnquiry` | Honeypot only. Fine: a person chose to enquire. |
| Pasted by the vendor (`newEnquiryAction`) | `ingest` → `processEnquiry` | None needed: the vendor chose it. |
| Partner referral (`referEnquiry`) | New enquiry for the partner → `processEnquiry` | None needed: a vendor chose it. |
| Instagram | Not built | n/a |

## Email headers we can read

- **Postmark:** `Headers` is an array of `{ Name, Value }`.
- **Mailgun:** `message-headers` is a JSON array of `[name, value]` pairs.
- **SendGrid Inbound Parse:** `headers` is the raw header block.

Each one carries `Auto-Submitted`, `X-Autoreply` / `X-Autorespond`, `Precedence`, `List-Unsubscribe`, `List-Id` and `From`. **Fix in this pack:** read them in the webhook (step 2).

## Where enquiries are counted

| Place | Verdict |
|---|---|
| Inbox lists (`inbox/page.tsx`: open / attention / won / closed / all) | Fix: filed messages get their own "Other" filter and are left out of the rest |
| Attention badge (`layout.tsx`), Overview drafts (`app/page.tsx`) | Fine as is: both are driven by drafts, and filed messages get none |
| `stats()` (dashboard numbers, conversion, by channel) | Fix: leave filed messages out |
| Lead score, follow-ups (`tick`), holds | Fine as is: they only run on drafted, quoted or awaiting enquiries; filed ones get none |
| Price-fishing lookup (enquiries from the same contact in the last 30 days) | Fix: leave filed messages out |
| Regular clients (`clients.ts`) | Fine as is: only counts booked, quoted or answered enquiries |
| Admin → Accounts enquiry count (`early-access.ts`) | Fix: leave filed messages out |
| AI usage | Fine as is: the reading call is still recorded |

## Loop risk

**Fix in this pack.** Today an out-of-office reply to one of our emails joins the open enquiry and gets a draft. With auto-send on, Matchire replies, which can trigger another auto-reply. Our automatic emails (auto-send and follow-ups) also don't mark themselves as automatic (`Auto-Submitted: auto-replied`), so other systems may answer them.

## Notes for later

- WhatsApp "status" and system messages aren't text, so they're already skipped.
- Instagram gets the same filter when it's built.
