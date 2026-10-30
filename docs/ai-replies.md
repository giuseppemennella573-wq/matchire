# How Matchire drafts replies (audit, Pack 04 step 1)

A map of the reply pipeline as it stood before Pack 04, so later changes have a
reference point. File and function names are the ones in `src/lib`.

## Where replies are drafted

Every channel ends up in the same two calls in `engine.ts`:

| Channel | Entry point | Then |
|---|---|---|
| WhatsApp | `app/api/webhooks/whatsapp/route.ts` | `ingest()` → `processEnquiry()` |
| Email | `app/api/webhooks/email/[token]/route.ts` | `ingest()` → `processEnquiry()` |
| Web form | `app/e/[slug]/actions.ts` | `ingest()` → `processEnquiry()` |
| Instagram / phone (pasted) | `newEnquiryAction` in `app/app/actions.ts` | `ingest()` → `processEnquiry()` |
| Planner reply logged by hand | `plannerReplyAction` | `appendInbound()` → `processEnquiry()` |
| "Redraft" / "Draft a reply now" | `draftAction` / `outcomeAction` | `processEnquiry()` |
| Follow-ups | `tick()` (every minute, and `/api/cron`) | `templateDraft()` with purpose `followup` / `last_call` |

`processEnquiry(vendorId, enquiryId)`:
1. Reads the details: `aiExtract()` (ai.ts) when an API key is set, otherwise
   `parseEnquiry()` (heuristics.ts). Merged with what's known via `mergeDetails()`.
2. Picks the package (`details.package_id`) and add-ons, then `buildQuote()`
   (pricing.ts) computes every number.
3. Checks the calendar (`availability()`), capacity, and `missingFields()`.
4. Chooses a `purpose`: quote, ask_info, answer, confirm, unavailable,
   over_capacity.
5. Drafts: `templateDraft()` always; with AI, `aiDraft()` replaces it unless the
   AI draft mentions an amount not in `allowedAmounts()` (`unknownAmounts()`
   guardrail).
6. Saves the draft (`messages.status = 'draft'`) and auto-sends it if
   `vendors.auto_send` is on and nothing needs the owner.

## Where a price can first appear

- `buildQuote()` runs whenever a package matches. The rules reader falls back
  to the closest package, so almost every enquiry gets a quote, even "how much?"
  with no date.
- `templateDraft()`, default branch (quote, ask_info, answer): appends
  `quoteText(quote)` whenever there is a quote, **regardless of purpose**. So an
  "ask for details" reply already contains prices. This is the first point.
- `aiDraft()` sees the full price list in its system prompt and the quote in its
  facts, and may quote from either; the guardrail only blocks amounts that
  aren't on the list.
- Partner "from" prices (`partnerView()`) are added for purpose `quote`.
- Follow-ups (`tick()` → `templateDraft('followup')`) repeat the stored quote
  total.

## Fields captured per enquiry

`Details` (types.ts), stored as JSON in `enquiries.details`: contact_name,
event_date (+ date_text, date_is_approximate), slot, start_time, hours, pax,
budget, event_type, location, package_id, addon_ids, needs, questions,
needs_owner / owner_reason, intent, summary.

Columns on `enquiries`: channel, contact_name / handle / email, status, lead,
quote (JSON `Quote`), owner_reason, event_date, first/last in/out timestamps,
followup_stage, next_followup_at, won_value, referred_from.

## Conversation state

- `enquiries.status` is the pipeline stage: new → awaiting_info → quoted →
  won / lost / referred / expired.
- The thread is `messages` (direction in / out / note; status draft / sent /
  manual / failed / discarded; purpose). At most one live draft per enquiry.
- Date holds are `holds` rows (hold / booking / block) with `expires_at`.
- Follow-up timing is `next_followup_at` + `followup_stage`.
- Details are re-derived from the whole thread on every `processEnquiry()` and
  merged into the stored JSON.
