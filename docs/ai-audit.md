# AI usage, vendor-written replies and returning clients (Pack 07, step 1)

## Claude calls today

| Function | What for | Model / effort | What goes in | How often |
|---|---|---|---|---|
| `aiExtract` (`src/lib/ai.ts`) | Read the conversation into booking details and intent | `MATCHIRE_MODEL` (default `claude-opus-5-5`), low effort | Vendor name and type, today's date, live price list, business notes, details so far, the whole conversation | Once per planner message (every `processEnquiry`) |
| `aiDraft` | Write the reply | Same model, medium effort | Tone, sign-off, rules, price list (none when qualifying or in Brief mode), business notes, the whole conversation, the facts (quote, hold, deposit, partners…) | Once per planner message, plus "Regenerate" and "Send price anyway" |
| `aiImportPriceList` | Turn a rate card into a price list | Same model, medium effort | The pasted text or the uploaded PDF or photo | Once per import |

All three go through `structured()` with the server-side refusal fallback. Nothing records token usage or cost, and there's no prompt caching. **Fix in this pack** (steps 2 and 5). Follow-ups and holds use fixed templates and never call Claude.

## Which outgoing messages the vendor wrote

| Kind | How it's stored | Can we tell? | Verdict |
|---|---|---|---|
| Reply from the vendor's phone (WhatsApp echo) | `direction='out'`, `status='manual'`, `purpose='phone_reply'` | Yes | Fine as is: best style example |
| AI or template draft the vendor edited, then sent or copied | `sendDraft` / `markDraftSentManually` overwrite `body`; the original draft isn't kept | **No** | **Fix in this pack**: record `edited` at send time, comparing the text sent with the draft |
| Draft sent unchanged, auto-sent reply, follow-up template | Same columns as above | No | Fix in this pack (same flag; auto-sends and templates are never "edited") |
| Messages sent before this pack | No flag | No | Note: only phone replies count from old history |

## Returning clients

| Today | Where | Verdict |
|---|---|---|
| A new message from the same contact handle or email joins an open enquiry from the last 60 days | `ingest` | Fine as is |
| Phone replies are matched to the latest WhatsApp enquiry from the last 60 days | `recordPhoneReply` | Fine as is |
| Enquiries from the same contact in the last 30 days feed the price-fishing check | `processEnquiry` | Fine as is |
| No "booked with you before" view for the vendor or the draft | n/a | **Fix in this pack** (step 4) |

How much each channel's identity can be trusted:
- **WhatsApp:** the number comes from Meta, so it's verified.
- **Email:** the sender address comes from the inbound webhook, so we treat it as verified.
- **Web form:** the name, number and email are typed in by whoever fills it in, so they're unverified.
- **Manual, Instagram and referral:** typed by the vendor or copied from elsewhere, so they're unverified for the draft.

## Privacy Policy and site claims

- The Privacy Policy says Anthropic receives "a vendor's price list, business notes and enquiry messages … only to do that". Style examples are the vendor's own earlier replies, cleaned of prices, dates and contact details. That fits "enquiry messages", but a clearer line would help. **Draft for approval in step 6.**
- positioning.md has no rows for learning the vendor's style or for regular clients. **Add in step 6.**
- No site claim mentions AI cost or the model. Fine as is.
