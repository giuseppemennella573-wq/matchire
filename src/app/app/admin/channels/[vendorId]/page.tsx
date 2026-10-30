import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getVendor } from "@/lib/engine";
import { channelAudit, channelView, ensureDisplayNumber } from "@/lib/channel-settings";
import { appUrl } from "@/lib/app-url";
import { formatDateTime } from "@/lib/dates";
import { saveVendorChannelsAction } from "../../actions";
import { CopyButton } from "@/components/copy-button";

export const metadata = { title: "Channels" };

function Copyable({ value }: { value: string }) {
  return <div className="row"><span className="code grow">{value}</span><CopyButton text={value} /></div>;
}

export default async function VendorChannels({ params, searchParams }: { params: Promise<{ vendorId: string }>; searchParams: Promise<{ msg?: string; error?: string }> }) {
  await requireAdmin();
  const { vendorId } = await params;
  const { msg, error } = await searchParams;
  const found = getVendor(Number(vendorId));
  if (!found) notFound();
  const v = await ensureDisplayNumber(found);
  const view = channelView(v, { admin: true, appUrl: appUrl() });
  const t = view.technical!;
  const log = channelAudit(v.id);

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <p className="eyebrow">Matchire admin</p>
          <h1>{v.name}: channels</h1>
          <p className="muted"><Link href="/app/admin/accounts">← Accounts</Link>. What you set here is what {v.name} sees as connected in their Settings.</p>
        </div>
      </div>
      {msg && <p className="alert alert-ok" role="status">{msg}</p>}
      {error && <p className="alert alert-err" role="alert">{error}</p>}

      <form action={saveVendorChannelsAction} className="stack-lg">
        <input type="hidden" name="vendorId" value={v.id} />
        <section className="card stack">
          <div className="row between">
            <h2>WhatsApp Business</h2>
            <span className={`badge ${view.whatsapp.connected ? "badge-ok" : ""}`}>
              {view.whatsapp.connected ? `Connected${view.whatsapp.number ? ` · ${view.whatsapp.number}` : ""}` : "Not connected"}
            </span>
          </div>
          <p className="small muted">In the Meta app, the webhook URL is the same for every vendor, with the verify token from <code>WHATSAPP_VERIFY_TOKEN</code>; subscribe to <code>messages</code> and <code>smb_message_echoes</code>.</p>
          <Copyable value={t.whatsappWebhookUrl} />
          <div className="grid2">
            <label className="field"><span>Phone number ID</span><input name="wa_phone_number_id" defaultValue={t.phoneNumberId ?? ""} autoComplete="off" /></label>
            <label className="field">
              <span>{t.tokenMasked ? <>Access token: saved, ending <span className="mono">{t.tokenMasked}</span>. Replace token</> : "Access token"}</span>
              <input name="wa_token" type="password" autoComplete="new-password" placeholder={t.tokenMasked ? "Leave blank to keep the saved token" : ""} />
            </label>
          </div>
          {view.whatsapp.connected && <label className="check small"><input type="checkbox" name="wa_disconnect" /><span>Disconnect this number</span></label>}
          <label className="check">
            <input type="checkbox" name="wa_templates_approved" defaultChecked={t.templatesApproved} />
            <span><b>Follow-up templates approved in Meta</b> <span className="muted">(<code>quote_nudge</code> and <code>quote_last_call</code>, Utility, English)</span></span>
          </label>
        </section>

        <section className="card stack">
          <h2>Email</h2>
          {view.email.address
            ? <><p className="small muted">Forwarding address the vendor sees:</p><Copyable value={view.email.address} /></>
            : <p className="small muted">No forwarding address yet (<code>INBOUND_EMAIL_DOMAIN</code> isn&apos;t set). Point the inbound email service at this webhook:</p>}
          <Copyable value={t.emailWebhookUrl} />
          <p className="small muted">{view.email.lastReceivedAt ? `Last email enquiry: ${formatDateTime(view.email.lastReceivedAt)}` : "No email enquiry received yet."}</p>
          <details>
            <summary className="small">Generate a new forwarding address</summary>
            <label className="check small" style={{ marginTop: 8 }}>
              <input type="checkbox" name="rotate_inbound" />
              <span>Replace the address. The old one stops working, and the vendor must update their forwarding rule.</span>
            </label>
          </details>
        </section>

        <div><button className="btn btn-primary" type="submit">Save channels</button></div>
      </form>

      <section className="card card-flush">
        <div className="card-head"><h2>Change log</h2><span className="small muted">Who changed what. Token values are never recorded.</span></div>
        {log.length === 0 ? <p className="empty">No changes yet.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Who</th><th>Changed</th></tr></thead>
              <tbody>{log.map((l, i) => <tr key={i}><td className="small">{formatDateTime(l.created_at)}</td><td className="small">{l.actor_email}</td><td>{l.field}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        {(view.whatsapp.setupRequestedAt || view.email.setupRequestedAt) && (
          <p className="small muted" style={{ padding: "0 16px 16px" }}>
            Setup requested: {[view.whatsapp.setupRequestedAt && `WhatsApp ${formatDateTime(view.whatsapp.setupRequestedAt)}`, view.email.setupRequestedAt && `email ${formatDateTime(view.email.setupRequestedAt)}`].filter(Boolean).join(", ")}
          </p>
        )}
      </section>
    </div>
  );
}
