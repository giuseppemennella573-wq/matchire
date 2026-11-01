# Vendor data privacy audit (Pack 06, step 1)

Who outside a vendor's own account can see their price list or other account data, as of the start of Pack 06.
"Admin" means a user whose email is in `ADMIN_EMAILS` (or the first user, if that's unset).

| # | Place | Who can see it | What exactly | Logged? | Verdict |
|---|---|---|---|---|---|
| 1 | Admin → Early access (`/app/admin`) and its CSV | Admins | Early-access sign-ups: name, business, email, phone, notes. No vendor account data, no prices. | No | Fine as is |
| 2 | Admin → Accounts | Admins | Per vendor: created, name, business, login email, a count of live price-list items (not the items or prices), enquiry count, status. Actions: reset link (goes to the vendor, not the admin), mark contacted, delete, Channels. | No | Fine as is (no prices). Gets the Support view button in step 3 |
| 3 | Admin → Channels (per vendor) | Admins | WhatsApp phone number ID, masked token, email forwarding address, template status, channel audit log. No prices, no enquiries. Admins can change channel settings here, and every change is already in the channel audit log. | Yes (channel audit) | Fine as is |
| 4 | Admin → Backups page and Download | Admins | The download is the **whole database** (every vendor's prices, enquiries, messages) as plain `.db.gz`. | Not logged | **Fix in this pack** (step 2: download the encrypted file only) |
| 5 | Database file and `backups/` folder on the Render disk | Anyone with Render dashboard/Shell access (Giuseppe) | Everything. The live database can't be encrypted at rest by us; Render encrypts its disks. Backups are plain gzip. | Render's own audit | **Fix in this pack** for backups (step 2). Live DB: note for later (Render access is Giuseppe only; keep 2FA on) |
| 6 | Daily backup email | `BACKUP_EMAIL`, else `EARLY_ACCESS_NOTIFY_EMAIL`, else giuseppe.mennella@matchire.ai, via Google Workspace | The whole database as an **unencrypted** `.db.gz` attachment, sitting in a mailbox. | Sent mail | **Fix in this pack** (step 2: encrypted, and not emailed at all without a password) |
| 7 | Server logs (Render) | Anyone with Render access | WhatsApp sender phone numbers, enquiry and vendor IDs, byte counts, and error text from WhatsApp/SMTP. **No message bodies, no prices, no tokens.** | n/a | Fine as is. Note for later: planner phone numbers in logs could be shortened |
| 8 | AI provider (Anthropic) | Anthropic, as a processor | On every enquiry: the vendor's name, type, live price list (names, prices, descriptions), business notes and the conversation, to extract details and draft the reply. On import: the uploaded rate card. Nothing else, and only when one of those happens. | Anthropic API logs | Fine as is. The privacy policy must describe it accurately (step 5) |
| 9 | "Log in as" a vendor | Nobody | There's no impersonation path. An admin can only send the vendor a password-reset link, which goes to the vendor's own email. | n/a | Fine as is. Step 3 adds a read-only, time-limited, logged Support view instead |
| 10 | Other vendors and partners | Partners | Name and category, plus one "from" price only if the vendor turns on `share_from_price`. | n/a | Fine as is |
| 11 | Demo reset endpoint (`/api/admin/seed-demo`) | Anyone with `CRON_SECRET` | Only rebuilds the demo account; returns counts. | No | Fine as is |

## What this pack fixes

- Backups on disk and in email are encrypted with `BACKUP_PASSWORD` (step 2).
- Admins get a logged, read-only Support view instead of needing the vendor's password (step 3).
- Vendors see every Support view session in Settings → Account (step 4).
- The Privacy Policy and the landing-page FAQ say so (step 5, after approval).
