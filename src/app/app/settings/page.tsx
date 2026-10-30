import { requireVendor } from "@/lib/auth";
import { VENDOR_KINDS } from "@/lib/types";
import { SETTINGS_TABS, notesPlaceholder, type SettingsTab } from "@/lib/settings-tabs";
import { QUALIFY_FIELDS, requiredFields } from "@/lib/qualify";
import { SettingsTabs } from "@/components/settings-tabs";
import { aiEnabled } from "@/lib/ai";
import { emailReady } from "@/lib/channels";
import { channelView, ensureDisplayNumber } from "@/lib/channel-settings";
import { isAdmin } from "@/lib/early-access";
import { appUrl } from "@/lib/app-url";
import { formatDateTime } from "@/lib/dates";
import { changePasswordAction, requestSetupAction, rotateInboundTokenAction, saveSettingsTabAction } from "../actions";
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

/** A tab's own form: saves only that tab's fields, with its Save bar fixed at the bottom. */
function TabForm({ tab, children, save = "Save" }: { tab: SettingsTab; children: React.ReactNode; save?: string }) {
  return (
    <form action={saveSettingsTabAction} data-tab-form={tab} className="stack-lg">
      <input type="hidden" name="tab" value={tab} />
      {children}
      <div className="savebar" data-savebar={tab}>
        <span className="unsaved small">Unsaved changes</span>
        <button className="btn btn-primary" type="submit">{save}</button>
      </div>
    </form>
  );
}

export default async function Settings({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string; tab?: string; saved?: string }> }) {
  const { user, vendor } = await requireVendor();
  const { msg, error, tab, saved } = await searchParams;
  const admin = isAdmin(user);
  const v = await ensureDisplayNumber(vendor);
  // Everything about channels on this page comes from this view; for vendors it holds no tokens, IDs or webhook URLs.
  const ch = channelView(v, { admin, appUrl: appUrl() });
  const initialTab = SETTINGS_TABS.some((t) => t.id === tab) ? tab! : null;

  return (
    <div className="stack-lg">
      <div className="page-head"><h1>Settings</h1></div>
      {msg && <p className="alert alert-ok" role="status">{msg}</p>}
      {error && <p className="alert alert-err" role="alert">{error}</p>}

      <SettingsTabs tabs={SETTINGS_TABS.map((t) => ({ id: t.id, label: t.label }))} initialTab={initialTab} saved={saved === "1"}>
        <section className="settings-panel" data-panel="business" aria-label="Business">
          <TabForm tab="business">
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
              <label className="field"><span>What Matchire should know about your business</span><textarea name="notes" rows={4} defaultValue={v.notes} placeholder={notesPlaceholder(v.kind)} /></label>
            </section>
          </TabForm>
        </section>

        <section className="settings-panel" data-panel="bookings" aria-label="Bookings">
          <TabForm tab="bookings">
            <section className="card stack">
              <h2>Bookings</h2>
              <div className="grid3">
                <label className="field"><span>Jobs you can take per day</span><input name="jobs_per_day" type="number" min="1" defaultValue={v.jobs_per_day} /></label>
                <label className="field"><span>Hold dates for (hours)</span><input name="hold_hours" type="number" min="1" defaultValue={v.hold_hours} /></label>
                <label className="field"><span>Follow up after (days)</span><input name="followup_days" type="number" min="0.5" step="0.5" defaultValue={v.followup_days} /></label>
                <label className="field"><span>Minimum spend (SGD)</span><input name="min_spend" type="number" min="0" step="0.01" defaultValue={v.min_spend || ""} /></label>
                <label className="field"><span>Off-peak discount % (Mon–Thu daytime)</span><input name="offpeak_discount" type="number" min="0" max="90" defaultValue={v.offpeak_discount || ""} /></label>
                <label className="field"><span>Max guests (venues)</span><input name="capacity" type="number" min="0" defaultValue={v.capacity ?? ""} /></label>
              </div>
              <label className="field"><span>Deposit instructions, sent when a planner says yes</span><textarea name="deposit_note" rows={2} defaultValue={v.deposit_note} placeholder="A 30% deposit via PayNow to UEN 2023xxxxxK secures your date." /></label>
            </section>
          </TabForm>
        </section>

        <section className="settings-panel stack-lg" data-panel="channels" aria-label="Channels">
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
          {ch.technical && (
            <TabForm tab="channels" save="Save connection">
              <details className="card stack" open={!ch.whatsapp.connected}>
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
                <p className="small muted">Email webhook for the inbound email service:</p>
                <Copyable value={ch.technical.emailWebhookUrl} />
                <p className="small muted">Outbound email: {emailReady() ? "on" : "off"}.</p>
              </details>
            </TabForm>
          )}
        </section>

        <section className="settings-panel" data-panel="partners" aria-label="Partners and referrals">
          <TabForm tab="partners">
            <section className="card stack">
              <h2>Partners &amp; referrals</h2>
              <label className="check">
                <input type="checkbox" name="bundle_suggestions" defaultChecked={!!v.bundle_suggestions} />
                <span><b>Suggest partners in quotes.</b> <span className="muted">Mention a partner vendor (and their starting price, if they share it) when an event needs more than you offer.</span></span>
              </label>
              <label className="check">
                <input type="checkbox" name="share_from_price" defaultChecked={!!v.share_from_price} />
                <span><b>Share my starting price with partners.</b> <span className="muted">Partners see your lowest live package price and can mention it when they suggest you to their clients. They never see your price list. Off: they only see your name and category.</span></span>
              </label>
              <label className="field" style={{ maxWidth: 260 }}><span>Default referral fee you charge partners (%)</span><input name="referral_fee_pct" type="number" min="0" max="50" defaultValue={v.referral_fee_pct} /></label>
            </section>
          </TabForm>
        </section>

        <section className="settings-panel" data-panel="ai" aria-label="AI and sending">
          <TabForm tab="ai">
            <section className="card stack">
              <h2>AI drafting</h2>
              {aiEnabled() ? (
                <p><span className="badge badge-ok">On</span> AI reads enquiries and drafts replies in your tone. Prices still come only from your price list, and drafts that mention any other amount are replaced with the standard template.</p>
              ) : (
                <p className="muted"><span className="badge">Off</span> Matchire is in rules mode: it reads enquiries with built-in rules and replies from templates. AI reading, drafting and rate-card import are switched off on this server.</p>
              )}
            </section>
            <section className="card stack">
              <h2>AI replies</h2>
              <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
                <legend className="small" style={{ fontWeight: 700, marginBottom: 6 }}>Before quoting, ask for</legend>
                <label className="check"><input type="checkbox" checked disabled readOnly /><span>Event date <span className="small muted">(always)</span></span></label>
                {QUALIFY_FIELDS.map((f) => (
                  <label key={f.id} className="check"><input type="checkbox" name={`qualify_${f.id}`} defaultChecked={requiredFields(v.qualify_fields).includes(f.id)} /><span>{f.label}</span></label>
                ))}
              </fieldset>
              <p className="small muted">Matchire never sends a price, range or &quot;from&quot; price until it has these. Leave the others unticked to quote once it has the date plus any one of guest count, venue, duration or event type. You can always choose &quot;Send price anyway&quot; on an enquiry.</p>
            </section>
            <section className="card stack">
              <h2>Sending</h2>
              <label className="check">
                <input type="checkbox" name="auto_send" defaultChecked={!!v.auto_send} disabled={!!v.is_demo} />
                <span><b>Auto-send routine replies.</b> <span className="muted">Quotes, requests for details and follow-ups go out without waiting for you. Anything unusual, any booking confirmation, and anything off your price list still waits for your approval.{v.is_demo ? <b> Locked off on the demo account.</b> : null}</span></span>
              </label>
              {ch.technical ? (
                <>
                  <label className="check">
                    <input type="checkbox" name="wa_templates_approved" defaultChecked={ch.technical.templatesApproved} />
                    <span><b>My follow-up templates are approved in Meta</b> <span className="small muted">(admin only)</span>. <span className="muted">Until <code>quote_nudge</code> and <code>quote_last_call</code> (Utility, English) are approved, WhatsApp follow-ups after the 24-hour window wait for you.</span></span>
                  </label>
                  <ul className="small muted">
                    <li><code>quote_nudge</code>: Hi {"{{1}}"}, just checking you saw our quote for {"{{2}}"}. Happy to answer any questions. Reply here anytime.</li>
                    <li><code>quote_last_call</code>: Hi {"{{1}}"}, we&apos;re holding {"{{2}}"} for you until {"{{3}}"}. Reply here if you&apos;d like to confirm.</li>
                  </ul>
                </>
              ) : (
                <p className="small muted">
                  <b>WhatsApp follow-up templates:</b> {v.wa_templates_approved ? "approved. Follow-ups after WhatsApp's 24-hour window go out automatically." : "not approved yet. We'll set these up with you; until then, follow-ups after WhatsApp's 24-hour window wait for you."}
                </p>
              )}
            </section>
          </TabForm>
        </section>

        <section className="settings-panel" data-panel="account" aria-label="Account">
          <section className="card stack">
            <h2>Password</h2>
            <form action={changePasswordAction} className="stack" style={{ maxWidth: 420 }}>
              <label className="field"><span>Current password</span><input name="current_password" type="password" required autoComplete="current-password" /></label>
              <label className="field"><span>New password</span><input name="new_password" type="password" required minLength={8} autoComplete="new-password" /></label>
              <label className="field"><span>Type the new password again</span><input name="confirm_password" type="password" required minLength={8} autoComplete="new-password" /></label>
              <div><button className="btn btn-ghost" type="submit">Change password</button></div>
            </form>
            <p className="small muted">Forgot it? Log out and use &quot;Forgot your password?&quot; on the login page.</p>
          </section>
        </section>
      </SettingsTabs>
    </div>
  );
}
