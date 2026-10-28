import { requireVendor } from "@/lib/auth";
import { VENDOR_KINDS } from "@/lib/types";
import { aiEnabled } from "@/lib/ai";
import { emailReady, inboundAddress, whatsappReady } from "@/lib/channels";
import { rotateInboundTokenAction, saveSettingsAction } from "../actions";
import { CopyButton } from "@/components/copy-button";

export const metadata = { title: "Settings" };

const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

function Copyable({ value }: { value: string }) {
  return <div className="row"><span className="code grow">{value}</span><CopyButton text={value} /></div>;
}

export default async function Settings({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { vendor: v } = await requireVendor();
  const { msg } = await searchParams;
  const url = appUrl();
  const inbound = inboundAddress(v);

  return (
    <div className="stack-lg">
      <div className="page-head"><h1>Settings</h1></div>
      {msg && <p className="alert alert-ok" role="status">{msg}</p>}

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
            <input type="checkbox" name="auto_send" defaultChecked={!!v.auto_send} />
            <span><b>Auto-send routine replies.</b> <span className="muted">Quotes, requests for details and follow-ups go out without waiting for you. Anything unusual, any booking confirmation, and anything off your price list still waits for your approval.</span></span>
          </label>
          <label className="check">
            <input type="checkbox" name="bundle_suggestions" defaultChecked={!!v.bundle_suggestions} />
            <span><b>Suggest partners in quotes.</b> <span className="muted">Mention a partner vendor and their starting price when an event needs more than you offer.</span></span>
          </label>
          <label className="field" style={{ maxWidth: 260 }}><span>Referral fee you charge partners (%)</span><input name="referral_fee_pct" type="number" min="0" max="50" defaultValue={v.referral_fee_pct} /></label>
        </section>

        <section className="card stack" id="channels">
          <h2>WhatsApp Business</h2>
          <p className="small muted">
            Connect your number through the WhatsApp Cloud API in Meta Business Suite. Your number stays the same.
            Set this webhook URL and the verify token from your server&apos;s <code>WHATSAPP_VERIFY_TOKEN</code>, and subscribe to <code>messages</code>.
          </p>
          <Copyable value={`${url}/api/webhooks/whatsapp`} />
          <div className="grid2">
            <label className="field"><span>Phone number ID</span><input name="wa_phone_number_id" defaultValue={v.wa_phone_number_id ?? ""} /></label>
            <label className="field"><span>Access token {v.wa_token ? "(saved; leave blank to keep)" : ""}</span><input name="wa_token" type="password" autoComplete="off" /></label>
          </div>
          <div className="row">
            <span className={`badge ${whatsappReady(v) ? "badge-ok" : ""}`}>{whatsappReady(v) ? "Connected" : "Not connected"}</span>
            {whatsappReady(v) && <label className="check small"><input type="checkbox" name="wa_disconnect" /><span>Disconnect</span></label>}
          </div>
          <p className="small muted">WhatsApp only lets businesses send free-form replies within 24 hours of the planner&apos;s last message. Matchire times follow-ups to land inside that window where it can; later ones go out as message templates, which Meta must approve first.</p>
          <label className="check">
            <input type="checkbox" name="wa_templates_approved" defaultChecked={!!v.wa_templates_approved} />
            <span><b>My follow-up templates are approved in Meta.</b> <span className="muted">In WhatsApp Manager, submit <code>quote_nudge</code> and <code>quote_last_call</code> (category Utility, language English) with exactly this wording. Until they&apos;re approved, late follow-ups wait for you instead of being sent.</span></span>
          </label>
          <ul className="small muted">
            <li><code>quote_nudge</code>: Hi {"{{1}}"}, just checking you saw our quote for {"{{2}}"}. Happy to answer any questions. Reply here anytime.</li>
            <li><code>quote_last_call</code>: Hi {"{{1}}"}, we&apos;re holding {"{{2}}"} for you until {"{{3}}"}. Reply here if you&apos;d like to confirm.</li>
          </ul>
        </section>

        <div><button className="btn btn-primary" type="submit">Save settings</button></div>
      </form>

      <section className="card stack">
        <h2>Email</h2>
        <p className="small muted">Forward enquiry emails to Matchire with your email provider&apos;s inbound webhook (Postmark, SendGrid, Mailgun, or a forwarding rule through any of them):</p>
        <Copyable value={`${url}/api/webhooks/email/${v.inbound_token}`} />
        {inbound && <p className="small">Or forward to <span className="code">{inbound}</span></p>}
        <div className="row">
          <span className={`badge ${emailReady() ? "badge-ok" : ""}`}>{emailReady() ? "Outbound email on" : "Outbound email off"}</span>
          <form action={rotateInboundTokenAction}><button className="btn btn-ghost btn-sm" type="submit">Generate a new address</button></form>
        </div>
      </section>

      <section className="card stack">
        <h2>Enquiry form</h2>
        <p className="small muted">Link this from your website, Instagram bio or Google Business profile. Enquiries land in your inbox, already priced.</p>
        <Copyable value={`${url}/e/${v.slug}`} />
        <p className="small muted">To embed it on your site:</p>
        <Copyable value={`<iframe src="${url}/e/${v.slug}?embed=1" style="width:100%;height:640px;border:0" title="Enquire with ${v.name}"></iframe>`} />
      </section>

      <section className="card stack" id="ai">
        <h2>AI</h2>
        {aiEnabled() ? (
          <p>Claude reads enquiries and drafts replies in your tone. Prices still come only from your price list, and drafts that mention any other amount are replaced with the standard template.</p>
        ) : (
          <p className="muted">Matchire is in rules mode: it reads enquiries with built-in rules and replies from templates. Set <code>ANTHROPIC_API_KEY</code> on the server to turn on AI reading, drafting and rate-card import.</p>
        )}
      </section>
    </div>
  );
}
