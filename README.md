# Matchire.ai

The AI booking desk for event vendors in Singapore. Matchire reads WhatsApp, email and web-form enquiries, quotes from the vendor's own price list, holds the date, follows up, and connects vendors with trusted partners.

## What's in the app

| Area | What it does |
| --- | --- |
| **Inbox** | Every enquiry from every channel in one place. Each is read for date, time, headcount, budget, event type and requests, priced, and answered with a drafted reply. |
| **Quotes** | Built only from the vendor's packages, add-ons, extra-hour rates, per-guest minimums, minimum spend and off-peak discount. The AI chooses *which* items fit; the code does the maths. AI drafts that mention any amount not on the quote or price list are thrown out and replaced with the standard template. |
| **Approval or auto-send** | Drafts wait for approval by default. With auto-send on, routine replies go straight out, but booking confirmations, unusual requests, anything off the price list, and capacity or availability problems still wait for the owner. |
| **Calendar holds** | Checks availability (jobs per day, blocked dates) before quoting, holds the date when a quote goes out, and releases it automatically when the hold expires. |
| **Follow-ups** | One nudge while the date is still held, then a last call shortly before the hold expires. Stops as soon as the planner replies. |
| **Partner network** | Vendors invite partners by code. Quotes can mention partners and their starting prices, and enquiries a vendor can't take can be referred, with the referral fee tracked when the partner books. |
| **Price-list import** | Paste a rate card or upload a PDF or photo; Claude turns it into items that stay hidden until the vendor approves them. |
| **Overview** | Enquiries, median first-reply time, bookings, booked value, referral fees and a breakdown by channel. |
| **Marketing site** | `public/landing.html` is served at `/`. Early-access sign-ups are saved, emailed to `EARLY_ACCESS_NOTIFY_EMAIL` (default giuseppe.mennella@matchire.ai), and listed on the admin page at `/app/admin`, with CSV export and a contacted flag. Admins are the logins in `ADMIN_EMAILS`, or the first account created if that's unset. |

## Running it

Needs Node 22.13 or newer (it uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env.local     # add ANTHROPIC_API_KEY for AI reading and drafting
npm run seed                   # demo data: demo@matchire.ai / matchire-demo
npm run dev                    # http://localhost:3000
```

Without `ANTHROPIC_API_KEY` Matchire runs in **rules mode**: a built-in parser reads enquiries and replies come from templates. Everything else works the same, so you can develop and demo without a key.

```bash
npm test          # quote engine, date parsing, enquiry reader, full booking flow
npm run typecheck
```

## Connecting channels

**WhatsApp (Meta WhatsApp Cloud API).** Create an app in Meta for Developers with the WhatsApp product. Set the webhook URL to `https://<your-domain>/api/webhooks/whatsapp` with the verify token from `WHATSAPP_VERIFY_TOKEN`, and subscribe to `messages`. Set `WHATSAPP_APP_SECRET` so webhook signatures are checked. Each vendor enters their phone number ID and access token under **Settings**. WhatsApp only allows free-form replies within 24 hours of the planner's last message; later replies fail with a clear error and need to be sent from the phone.

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

## Code map

```
src/lib/engine.ts      the booking desk: intake → read → quote → draft → send → hold → follow-up → outcome
src/lib/pricing.ts     quote engine and the "never invent a price" guardrail
src/lib/ai.ts          Claude calls (structured outputs, refusal fallback), validated before use
src/lib/heuristics.ts  rules-based enquiry reader (no-key mode and fallback)
src/lib/dates.ts       Singapore-time date parsing ("next tue", "15 Nov", "early Dec")
src/lib/channels.ts    WhatsApp Cloud API and email (SMTP or Resend) delivery
src/lib/db.ts          SQLite schema
src/app/app/*          the vendor app (server components + server actions)
src/app/api/*          webhooks, cron, early-access
src/app/e/[slug]       public enquiry form
```

AI calls use `claude-opus-5-5` (override with `MATCHIRE_MODEL`) with server-side refusal fallback enabled, so if the model declines a request for policy reasons the API retries on its default fallback model.
