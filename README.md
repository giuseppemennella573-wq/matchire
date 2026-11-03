# Matchire.ai

The AI booking desk for event vendors in Singapore. Matchire reads WhatsApp, email and web-form enquiries, quotes from the vendor's own price list, holds the date, follows up, and connects vendors with trusted partners.

## What's in the app

| Area | What it does |
| --- | --- |
| **Inbox** | Every enquiry from every channel in one place. Each is read for date, time, headcount, budget, event type and requests, priced, and answered with a drafted reply. |
| **Quotes** | Built only from the vendor's packages, add-ons, extra-hour rates, per-guest minimums, minimum spend and off-peak discount. The AI chooses *which* items fit; the code does the maths. AI drafts that mention any amount not on the quote or price list are thrown out and replaced with the standard template. |
| **Approval or auto-send** | Drafts wait for approval by default. With auto-send on, routine replies go straight out, but booking confirmations, unusual requests, anything off the price list, and capacity or availability problems still wait for the owner. |
| **Calendar holds** | Checks availability (jobs per day, blocked dates) before quoting, holds the date when a quote goes out, and releases it automatically when the hold expires. |
| **Follow-ups** | One nudge while the date is still held, then a last call shortly before the hold expires. Stops as soon as the planner replies. On WhatsApp they respect the 24-hour window (see below). |
| **Partner network** | Vendors invite partners by code. Quotes can suggest partners by name and category, and enquiries a vendor can't take can be referred, with the referral fee tracked when the partner books. |
| **Rate privacy** | A vendor's price list is private to their account. Other businesses only see a partner's lowest live package price, and only if that partner turns on **Share my starting price with partners** (off by default). AI prompts never include another vendor's price list, and referrals pass on only the planner's own messages. All of this goes through `partnerView()` / `sharedFromPrice()` in `src/lib/engine.ts`. |
| **Price-list import** | Paste a rate card or upload a PDF or photo; Claude turns it into items that stay hidden until the vendor approves them. |
| **Overview** | Enquiries, median first-reply time, bookings, booked value, referral fees and a breakdown by channel. |
| **Marketing site** | `public/landing.html` is served at `/`. Early-access sign-ups are saved, emailed to `EARLY_ACCESS_NOTIFY_EMAIL` (default giuseppe.mennella@matchire.ai), and listed on the admin page at `/app/admin`, with CSV export and a contacted flag. Admins are the logins in `ADMIN_EMAILS`, or the first account created if that's unset. |

## Running it

Needs Node 22.13 or newer (it uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env.local     # add ANTHROPIC_API_KEY for AI reading and drafting
npm run seed                   # dev data: dev@matchire.ai / matchire-demo
npm run dev                    # http://localhost:3000
```

Without `ANTHROPIC_API_KEY` Matchire runs in **rules mode**: a built-in parser reads enquiries and replies come from templates. Everything else works the same, so you can develop and demo without a key.

```bash
npm test          # quote engine, date parsing, enquiry reader, full booking flow
npm run typecheck
```

## Connecting channels

**Who sees what.** Vendors' Settings show plain status cards only (WhatsApp connected and the number, the email forwarding address, the web form link, Instagram "Coming soon") with **Request setup**, which emails the admin at most once a day per channel. Tokens, IDs and webhook URLs are never sent to a vendor's browser (`channelView()` in `src/lib/channel-settings.ts`). Admins connect a vendor under **Matchire admin → Accounts → Channels**: the phone number ID is shown in full, a saved access token only as its last 4 characters, and each change is logged (who, when, which field; never the token).

**WhatsApp (Meta WhatsApp Cloud API).** Create an app in Meta for Developers with the WhatsApp product. Set the webhook URL to `https://<your-domain>/api/webhooks/whatsapp` with the verify token from `WHATSAPP_VERIFY_TOKEN`, and subscribe to `messages`. Set `WHATSAPP_APP_SECRET` so webhook signatures are checked. An admin enters each vendor's phone number ID and access token under **Matchire admin → Accounts → Channels**. WhatsApp only allows free-form replies within 24 hours of the planner's last message; later replies fail with a clear error and need to be sent from the phone.

**Vendors replying from their phone (coexistence).** When a vendor's number is connected with coexistence, they keep using the WhatsApp Business app, and Meta sends a copy of each message they send from it. Subscribe the webhook to the `smb_message_echoes` field as well as `messages`. A reply from the phone joins the enquiry ("from your WhatsApp app"), drops any pending Matchire draft and stops follow-ups, so the planner never gets a second answer; it also wins if it arrives while a draft is being written. Chats with people who aren't an enquiry are ignored. See `recordPhoneReply()` in `src/lib/engine.ts`.

**WhatsApp follow-ups and the 24-hour window.** The window runs from the planner's *last inbound* message. For each follow-up:

1. If it's due at least an hour before the window closes, it goes out as normal free-form text.
2. If it would be due later, the nudge is pulled forward to an hour before the window closes, as long as that's still at least 4 hours after the quote went out. (The last call is never moved earlier.)
3. Otherwise it goes out as a pre-approved **template**. The draft shows the exact template text and can't be edited.

A draft that waits for approval is checked again when it's sent, so one approved after the window closed still goes out as a template. If the vendor hasn't ticked **My follow-up templates are approved in Meta** in Settings, nothing is sent: the server logs `[whatsapp] follow-up … not sent`, and the enquiry shows **Follow-up needs template approval** under *Needs you*. Follow-ups after a request for details (no quote) have no template, so outside the window they're flagged for the vendor to send from their phone. Email follow-ups are unaffected.

Each vendor submits these in **WhatsApp Manager → Message templates** on their own WhatsApp Business account, category **Utility**, language **English (`en`)**, with exactly this wording (the language code is set in `src/lib/channels.ts` and must match):

| Name | Body | Sample values |
| --- | --- | --- |
| `quote_nudge` | Hi {{1}}, just checking you saw our quote for {{2}}. Happy to answer any questions. Reply here anytime. | `Mei`, `Sat, 15 Nov` |
| `quote_last_call` | Hi {{1}}, we're holding {{2}} for you until {{3}}. Reply here if you'd like to confirm. | `Mei`, `Sat, 15 Nov`, `13 Nov, 06:00 pm` |

{{1}} is the planner's first name (or "there"), {{2}} the event date (or "your event" if there's no exact date), {{3}} when the hold ends. Meta usually reviews Utility templates within a day. Once both show **Active**, tick the box in Settings.

**Email.** Point an inbound-email webhook (Postmark, SendGrid Inbound Parse, Mailgun routes) at the per-vendor URL shown in **Settings**: `https://<your-domain>/api/webhooks/email/<token>`. Outbound email goes over SMTP: for Google Workspace set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER` (the mailbox) and `SMTP_PASS` (an [app password](https://myaccount.google.com/apppasswords); needs 2-Step Verification). `EMAIL_FROM` must be that mailbox or one of its aliases. [Resend](https://resend.com) (`RESEND_API_KEY`) is supported as an alternative. Optionally set `INBOUND_EMAIL_DOMAIN` so replies come back to `<token>@<domain>`.

**Web form.** Each vendor has a public form at `/e/<slug>`, embeddable as an iframe (`?embed=1`).

**Anything else (Instagram, calls).** Paste the message into the inbox; the reply is drafted the same way, and **I sent it myself** marks it as sent once copied.

## Deploying

The app keeps its data in one SQLite file, so it needs a host with a persistent disk (Fly.io, Railway, Render, a VPS). It won't work on serverless hosts that have no disk.

**Render (one click):** in the Render dashboard choose **New → Blueprint**, pick this repository, and fill in `APP_URL` and `ANTHROPIC_API_KEY`. `render.yaml` sets up a Singapore web service with a 1 GB disk.

**Fly.io:**
```bash
fly launch --copy-config --no-deploy
fly volumes create matchire_data --region sin --size 1
fly secrets set APP_URL=https://matchire.fly.dev ANTHROPIC_API_KEY=... CRON_SECRET=... WHATSAPP_VERIFY_TOKEN=...
fly deploy
```

**Any Docker host:**
```bash
docker build -t matchire .
docker run -p 3000:3000 -v matchire-data:/data --env-file .env matchire
```

Follow-ups and hold expiry run in-process every minute. On hosts that sleep idle apps, also call `GET /api/cron` with `Authorization: Bearer $CRON_SECRET` from an external scheduler.

## Backups

Every day at 3 am Singapore time the scheduler takes a clean copy of the database (SQLite `VACUUM INTO`, gzip-compressed), **encrypts it** (AES-256-GCM, key derived from `BACKUP_PASSWORD` with scrypt; random salt and IV in the file header), keeps the last 14 in `backups/` next to the database as `matchire-<time>.db.gz.enc`, and emails it to `BACKUP_EMAIL` (default: `EARLY_ACCESS_NOTIFY_EMAIL`, then giuseppe.mennella@matchire.ai) as the off-site copy. Admins can take one on demand and download any of them (still encrypted) at `/app/admin/backups`. Render's own daily disk snapshots (kept at least 7 days) are a last resort on top.

- **`BACKUP_PASSWORD`**: set it in Render → Environment and keep it in your password manager. Without it nobody, including you, can open a backup. Changing it only affects new backups; older ones still need the old password.
- **If it isn't set**, backups are still taken but stay on the server unencrypted (`.db.gz`) and are **not emailed**, and admins see a warning on every page.
- Unencrypted backups from before (or taken without a password) are listed on `/app/admin/backups` with a **Delete unencrypted backups** button.

### Restoring a backup

Restoring replaces all data with the backup's contents; anything since then is lost.

1. Pick the backup on `/app/admin/backups` and note its file name, e.g. `matchire-2026-10-27T19-00-00Z.db.gz.enc`.
2. In Render, open the service's **Shell** and run, with that file name:
   ```bash
   cd /data
   node /app/scripts/decrypt-backup.mjs backups/matchire-2026-10-27T19-00-00Z.db.gz.enc restore.db
   ```
   It uses `BACKUP_PASSWORD` from the environment (already set on Render), or asks for it. A wrong password stops with "Wrong password, or the backup file is damaged" and writes nothing. Old unencrypted `.db.gz` files work too, with no password.
3. Then swap the files:
   ```bash
   mv matchire.db matchire-before-restore.db
   rm -f matchire.db-wal matchire.db-shm
   mv restore.db matchire.db
   ```
4. Straight away, choose **Manual Deploy → Restart service** so the app opens the restored file.
5. Check the app. The previous database is kept as `matchire-before-restore.db` until you delete it.

**From an emailed copy, on your laptop:** save the `.db.gz.enc` attachment, then in this repo run `node scripts/decrypt-backup.mjs ~/Downloads/matchire-….db.gz.enc` (Node 22+, no install needed). It asks for the password and writes `matchire-….db`, which you can open with any SQLite tool. To put it back on the server, upload it to `/data` and do steps 3–5 (or ask for an upload-and-restore button).

## Demo account

`demo@matchire.ai` is a safe workspace to show prospects: **Snap & Smile Photobooth** with its price list, a partner caterer (Rempah Kitchen), a fully booked Saturday three weeks out, and three enquiries (WhatsApp, Instagram, email) drafted by the normal pipeline. Demo accounts (`vendors.is_demo`) never send anything: WhatsApp, email and template sends are simulated at the send layer (logged as `demo: not sent`), auto-send is locked off, no password-reset email goes out, and they can only partner with other demo accounts.

Reset it (same result every time, never duplicates) with **Reset demo** on Matchire admin → Accounts, or:

- locally: `DEMO_PASSWORD=... npm run seed:demo`
- on Render (the image has no TypeScript scripts): set `DEMO_PASSWORD` in Environment, then in the service's **Shell** run
  `node -e "fetch('http://localhost:3000/api/admin/seed-demo',{method:'POST',headers:{authorization:'Bearer '+process.env.CRON_SECRET}}).then(r=>r.text()).then(console.log)"`

The local development seed (`npm run seed`) is separate and logs in as `dev@matchire.ai`.

## Inbox filter (what doesn't get a reply)

Every incoming message is sorted before anything is drafted:
- **Automated email** (out-of-office, newsletters, bounces, no-reply senders) is recognised from its headers (`src/lib/automated.ts`) and filed under **Other** without the AI. An auto-reply on an open enquiry becomes a short note. Matchire's own automatic emails carry `Auto-Submitted: auto-replied` so nothing loops.
- **Hidden contacts** ("Never show messages from this number"; Settings → Channels) are dropped in the webhooks before anything is stored or read. Only a count is kept (`contact_rules`, kind `hidden`).
- **Booked clients:** a WhatsApp or email message from a client with an upcoming booking joins that booking, with no sales draft. An explicit different date starts a new enquiry.
- **The AI's answer:** the existing reading call also returns `relevance` (enquiry / not_enquiry / unsure). `not_enquiry` files the conversation under Other with a reason; `unsure` keeps it in the inbox tagged "Check this" and blocks auto-send. Never filed: website-form, pasted and referred enquiries, conversations the vendor answered or holds a date for, rules mode, and contacts the vendor marked "always a client" (`contact_rules`, kind `always`).
- **Corrections:** "Move to Enquiries" brings a conversation back, marks the contact "always a client" and drafts as usual; "Not an enquiry" files it (optionally hiding the contact).

## Equipment and availability

Before quoting or holding a date, Matchire checks it's free:
- **Equipment** (Price list → Your equipment): what the vendor owns and how many, e.g. Print booth × 6, 360 booth × 2. Each package (or add-on) can **use** one piece of equipment; add-ons like a guestbook album use nothing. A date is free for a package while its equipment has a unit left. Holds and bookings record the equipment they take (`hold_equipment`). When the requested equipment is full but the day isn't, the reply offers a package that's free that day with its real price, plus the dates the requested equipment is free.
- **Most jobs in one day** (Settings → Bookings, `vendors.jobs_per_day`): an optional cap on top, e.g. for the number of attendants. Empty (0) means no cap for vendors with equipment; a vendor without equipment is always limited to this number, or 1.
- **Blocked dates** (Calendar) close the whole day. **Add a booking** records a job taken outside Matchire, with its equipment.
- Per day only: the same booth doing a morning and an evening job isn't modelled yet.

## Support view (opening a vendor's account)

Admins never need a vendor's password. On **Matchire admin → Accounts**, **Support view** asks for a reason and opens that vendor's desk **read-only for 30 minutes**: every vendor action (send, save, delete, settings) is refused, and a banner with **End now** stays on every page. Each session (admin, reason, start and end) and every page opened (path only) is stored in `support_access`, the vendor is emailed when it starts (never for demo accounts), and they see the full list in **Settings → Account → Matchire support access**. Vendor server actions must use `requireVendorForAction()`, which is what enforces read-only; a test checks this.

## Passwords

Anyone can reset their own password from **Forgot your password?** on the login page: Matchire emails a one-time link that expires after an hour (only its hash is stored), and setting a new password logs the account out everywhere. Logged-in users can change it under **Settings → Password**, and admins can email anyone a reset link from **Matchire admin → Accounts**. Links use `APP_URL`, so it must be set in production.

If email isn't working, reset a password from the server: in Render, open the service's **Shell** and run `node scripts/set-password.mjs you@example.com`, then type the new password when asked.

## Code map

```
src/lib/engine.ts      the booking desk: intake → read → quote → draft → send → hold → follow-up → outcome
src/lib/pricing.ts     quote engine and the "never invent a price" guardrail
src/lib/ai.ts          Claude calls (structured outputs, refusal fallback), validated before use
src/lib/ai-usage.ts    tokens and cost of every Claude call (Matchire admin → AI usage)
src/lib/style.ts       the vendor's own replies, cleaned, as style examples for drafts
src/lib/clients.ts     regular clients: earlier enquiries from the same number or email
src/lib/equipment.ts   what a vendor owns; availability per equipment is in engine.ts
src/lib/automated.ts   recognising automated email (out-of-office, newsletters, bounces)
src/lib/contacts.ts    per-vendor contact rules: hidden, or always a client
src/lib/heuristics.ts  rules-based enquiry reader (no-key mode and fallback)
src/lib/dates.ts       Singapore-time date parsing ("next tue", "15 Nov", "early Dec")
src/lib/channels.ts    WhatsApp Cloud API and email (SMTP or Resend) delivery
src/lib/backup.ts      daily encrypted database backups, kept 14 days and emailed off-site
src/lib/support.ts     Support view: logged, read-only, 30-minute admin access to a vendor's desk
src/lib/db.ts          SQLite schema
src/app/app/*          the vendor app (server components + server actions)
src/app/api/*          webhooks, cron, early-access
src/app/e/[slug]       public enquiry form
```

AI calls use `claude-opus-5-5` (override with `MATCHIRE_MODEL`) with server-side refusal fallback enabled, so if the model declines a request for policy reasons the API retries on its default fallback model.

- **What it costs:** every call is recorded in `ai_usage` (tokens and cost, no content) and shown on **Matchire admin → AI usage**. Prices per million tokens live in `src/lib/ai-usage.ts`.
- **Prompt caching:** the stable part of each prompt (rules, price list, business notes, style examples) is marked for caching, so repeat calls for a vendor within 5 minutes pay about 5% for that part. Prompts under 512 tokens (usually the enquiry-reading one) simply aren't cached. Turn it off with `MATCHIRE_PROMPT_CACHE=off`.
- **A cheaper model for reading enquiries:** `MATCHIRE_EXTRACT_MODEL` (default: the main model). Compare first with `ANTHROPIC_API_KEY=... node --experimental-strip-types scripts/eval-extract.ts` (16 labelled enquiries; a few cents per model). Drafting always uses the main model.
