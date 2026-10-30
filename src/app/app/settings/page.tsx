import { requireVendor } from "@/lib/auth";
import { VENDOR_KINDS } from "@/lib/types";
import { aiEnabled } from "@/lib/ai";
import { emailReady } from "@/lib/channels";
import { channelView, ensureDisplayNumber } from "@/lib/channel-settings";
import { isAdmin } from "@/lib/early-access";
import { appUrl } from "@/lib/app-url";
import { formatDateTime } from "@/lib/dates";
import { changePasswordAction, requestSetupAction, rotateInboundTokenAction, saveSettingsAction } from "../actions";
import { CopyButton } from "@/components/copy-button";

export const metadata = { title: "Settings" };

function Copyable({ value }: { value: string }) {
  return <div className="row"><span className="code grow">{value}</span><CopyButton text={value} /></div>;
}

function RequestSetup({ channel, requestedAt }: { channel: "whatsapp" | "email"; requestedAt: string | null }) {
  return (
    <form action={requestSetupAction} className="row">
      <input type="hidden" name="channel" value={channel} />
      <button className="btn btn-primary btn-sm" type="submit">Request setup</button>
      {requestedAt && <span className="small muted">Requested {formatDateTime(requestedAt)}</span>}
    </form>
  );
}

export default async function Settings({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string }> }) {
  const { user, vendor } = await requireVendor();
  const { msg, error } = await searchParams;
  const admin = isAdmin(user);
  const v = await ensureDisplayNumber(vendor);
  // Everything about channels on this page comes from this view; for vendors it holds no tokens, IDs or webhook URLs.
  const ch = channelView(v, { admin, appUrl: appUrl() });

  return (
    <div className="stack-lg">
      <div className="page-head"><h1>Settings</h1></div>
      {msg && <p className="alert alert-ok" role="status">{msg}</p>}
      {error && <p className="alert alert-err" role="alert">{error}</p>}

      <form action={saveSettingsAction} className="stack-lg">
        <section className="card stack">
          <h2>Business</h2>
          <div className="grid2">
            <label className="field"><span>Business name</span><input name="name" defaultValue={v.name} required /></label>
            <label className="field"><span>Category</span>
              <select name="kind" defaultValue={v.kind}>{VENDOR_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>
            </label>
          </div>
          <label className="field"><span>Your tone of voice</span><textarea name="tone" rows={2} defaultValue={v.tone} /></label>
          <label className="field"><span>Sign replies as</span><input name="signoff" defaultValue={v.signoff} placeholder={`Ana, ${v.name}`} /></label>
          <label className="field"><span>Things Matchire should know (policies, location, what you don&apos;t do)</span><textarea name="notes" rows={4} defaultValue={v.notes} placeholder="We're at 12 Telok Ayer St. Outside catering allowed with a $100 cleaning fee. No confetti." /></label>
          <label className="field"><span>Deposit instructions, sent when a planner says yes</span><textarea name="deposit_note" rows={2} defaultValue={v.deposit_note} placeholder="A 30% deposit via PayNow to UEN 2023xxxxxK secures your date." /></label>
        </section>

        <section className="card stack">
          <h2>Booking rules</h2>
          <div className="grid3">
            <label className="field"><span>Jobs you can take per day</span><input name="jobs_per_day" type="number" min="1" defaultValue={v.jobs_per_day} /></label>
            <label className="field"><span>Max guests (venues)</span><input name="capacity" type="number" min="0" defaultValue={v.capacity ?? ""} /></label>
            <label className="field"><span>Minimum spend (SGD)</span><input name="min_spend" type="number" min="0" step="0.01" defaultValue={v.min_spend || ""} /></label>
            <label className="field"><span>Off-peak discount % (Mon–Thu daytime)</span><input name="offpeak_discount" type="number" min="0" max="90" defaultValue={v.offpeak_discount || ""} /></label>
            <label className="field"><span>Hold dates for (hours)</span><input name="hold_hours" type="number" min="1" defaultValue={v.hold_hours} /></label>
            <label className="field"><span>Follow up after (days)</span><input name="followup_days" type="number" min="0.5" step="0.5" defaultValue={v.followup_days} /></label>
          </div>
        </section>

        <section className="card stack">
          <h2>How hands-off to be</h2>
          <label className="check">
            <input type="checkbox" name="auto_send" defaultChecked={!!v.auto_send} disabled={!!v.is_demo} />
            <span><b>Auto-send routine replies.</b> <span className="muted">Quotes, requests for details and follow-ups go out without waiting for you. Anything unusual, any booking confirmation, and anything off your price list still waits for your approval.{v.is_demo ? <b> Locked off on the demo account.</b> : null}</span></span>
          </label>
          <label className="check">
            <input type="checkbox" name="bundle_suggestions" defaultChecked={!!v.bundle_suggestions} />
            <span><b>Suggest partners in quotes.</b> <span className="muted">Mention a partner vendor (and their starting price, if they share it) when an event needs more than you offer.</span></span>
          </label>
          <label className="check">
            <input type="checkbox" name="share_from_price" defaultChecked={!!v.share_from_price} />
            <span><b>Share my starting price with partners.</b> <span className="muted">Partners see your lowest live package price and can mention it when they suggest you to their clients. They never see your price list. Off: they only see your name and category.</span></span>
          </label>
          <label className="field" style={{ maxWidth: 260 }}><span>Referral fee you charge partners (%)</span><input name="referral_fee_pct" type="number" min="0" max="50" defaultValue={v.referral_fee_pct} /></label>
        </section>

        {ch.technical && (
          <details className="card stack">
            <summary><b>Technical (admin only)</b> <span className="small muted">Your own account&apos;s WhatsApp and email connection. For other vendors, use Matchire admin → Accounts → Channels.</span></summary>
            <p className="small muted">Webhook URL for the Meta app, with the verify token from <code>WHATSAPP_VERIFY_TOKEN</code>; subscribe to <code>messages</code> and <code>smb_message_echoes</code>.</p>
            <Copyable value={ch.technical.whatsappWebhookUrl} />
            <div className="grid2">
              <label className="field"><span>Phone number ID</span><input name="wa_phone_number_id" defaultValue={ch.technical.phoneNumberId ?? ""} autoComplete="off" /></label>
              <label className="field">
                <span>{ch.technical.tokenMasked ? <>Access token: saved, ending <span className="mono">{ch.technical.tokenMasked}</span>. Replace token</> : "Access token"}</span>
                <input name="wa_token" type="password" autoComplete="new-password" placeholder={ch.technical.tokenMasked ? "Leave blank to keep the saved token" : ""} />
              </label>
            </div>
            {ch.whatsapp.connected && <label className="check small"><input type="checkbox" name="wa_disconnect" /><span>Disconnect</span></label>}
            <label className="check">
              <input type="checkbox" name="wa_templates_approved" defaultChecked={ch.technical.templatesApproved} />
              <span><b>My follow-up templates are approved in Meta.</b> <span className="muted">Until <code>quote_nudge</code> and <code>quote_last_call</code> (Utility, English) are approved, follow-ups after WhatsApp&apos;s 24-hour window wait for you instead of being sent.</span></span>
            </label>
            <ul className="small muted">
              <li><code>quote_nudge</code>: Hi {"{{1}}"}, just checking you saw our quote for {"{{2}}"}. Happy to answer any questions. Reply here anytime.</li>
              <li><code>quote_last_call</code>: Hi {"{{1}}"}, we&apos;re holding {"{{2}}"} for you until {"{{3}}"}. Reply here if you&apos;d like to confirm.</li>
            </ul>
            <p className="small muted">Email webhook for the inbound email service:</p>
            <Copyable value={ch.technical.emailWebhookUrl} />
            <p className="small muted">Outbound email: {emailReady() ? "on" : "off"}.</p>
          </details>
        )}

        <div><button className="btn btn-primary" type="submit">Save settings</button></div>
      </form>

      <h2 id="channels" style={{ marginTop: 8 }}>Where enquiries come from</h2>

      <section className="card stack">
        <div className="row between">
          <h2>WhatsApp</h2>
          <span className={`badge ${ch.whatsapp.connected ? "badge-ok" : ""}`}>{ch.whatsapp.connected ? "Connected" : "Not connected"}</span>
        </div>
        {ch.whatsapp.connected ? (
          <p>Enquiries to {ch.whatsapp.number ? <b>{ch.whatsapp.number}</b> : "your WhatsApp Business number"} land in your inbox, and your replies go out from that number.</p>
        ) : (
          <>
            <p className="muted">We&apos;ll set this up with you during early access. You keep your existing WhatsApp Business number.</p>
            <RequestSetup channel="whatsapp" requestedAt={ch.whatsapp.setupRequestedAt} />
          </>
        )}
      </section>

      <section className="card stack">
        <div className="row between">
          <h2>Email</h2>
          {ch.email.address && <span className={`badge ${ch.email.receiving ? "badge-ok" : ""}`}>{ch.email.receiving ? "Receiving" : "Waiting for first email"}</span>}
        </div>
        {ch.email.address ? (
          <>
            <p className="muted">Forward your enquiries to:</p>
            <Copyable value={ch.email.address} />
            <details>
              <summary className="small muted">Advanced</summary>
              <form action={rotateInboundTokenAction} className="stack" style={{ marginTop: 8 }}>
                <label className="check small">
                  <input type="checkbox" name="confirm" required />
                  <span>Yes, give me a new address. The old one stops working, so I&apos;ll update my forwarding rule.</span>
                </label>
                <div><button className="btn btn-ghost btn-sm" type="submit">Generate a new address</button></div>
              </form>
            </details>
          </>
        ) : (
          <>
            <p className="muted">Not set up yet. We&apos;ll set up email forwarding with you during early access.</p>
            <RequestSetup channel="email" requestedAt={ch.email.setupRequestedAt} />
          </>
        )}
      </section>

      <section className="card stack">
        <h2>Web form</h2>
        <p className="small muted">Link this from your website, Instagram bio or Google Business profile. Enquiries land in your inbox, already priced.</p>
        <div className="row">
          <span className="code grow">{ch.form.url}</span>
          <CopyButton text={ch.form.url} />
          <a className="btn btn-ghost btn-sm" href={ch.form.url} target="_blank" rel="noopener">Open</a>
        </div>
        <details>
          <summary className="small muted">Advanced: embed it on your website</summary>
          <div style={{ marginTop: 8 }}>
            <Copyable value={`<iframe src="${ch.form.embedUrl}" style="width:100%;height:640px;border:0" title="Enquire with ${v.name}"></iframe>`} />
          </div>
        </details>
      </section>

      <section className="card stack">
        <div className="row between">
          <h2>Instagram DMs</h2>
          <span className="soon">Coming soon</span>
        </div>
        <p className="small muted">For now, paste Instagram messages into your inbox with <b>Add an enquiry</b>, and Matchire drafts the reply the same way.</p>
      </section>

      <section className="card stack" id="password">
        <h2>Password</h2>
        <form action={changePasswordAction} className="stack" style={{ maxWidth: 420 }}>
          <label className="field"><span>Current password</span><input name="current_password" type="password" required autoComplete="current-password" /></label>
          <label className="field"><span>New password</span><input name="new_password" type="password" required minLength={8} autoComplete="new-password" /></label>
          <label className="field"><span>Type the new password again</span><input name="confirm_password" type="password" required minLength={8} autoComplete="new-password" /></label>
          <div><button className="btn btn-ghost" type="submit">Change password</button></div>
        </form>
        <p className="small muted">Forgot it? Log out and use &quot;Forgot your password?&quot; on the login page.</p>
      </section>

      <section className="card stack" id="ai">
        <h2>AI</h2>
        {aiEnabled() ? (
          <p>AI reads enquiries and drafts replies in your tone. Prices still come only from your price list, and drafts that mention any other amount are replaced with the standard template.</p>
        ) : (
          <p className="muted">Matchire is in rules mode: it reads enquiries with built-in rules and replies from templates. AI reading, drafting and rate-card import are switched off on this server.</p>
        )}
      </section>
    </div>
  );
}
