import { redirect } from "next/navigation";
import { requireVendor } from "@/lib/auth";
import { accountsWaiting, ALERT_TO, isAdmin, listAccounts, listSignups, whatsappLink } from "@/lib/early-access";
import { kindLabel } from "@/lib/engine";
import { emailReady } from "@/lib/channels";
import { formatDateTime } from "@/lib/dates";
import { deleteSignupAction, resendAlertAction, toggleAccountContactedAction, toggleContactedAction } from "./actions";
import { ConfirmSubmit } from "@/components/confirm-submit";

export const metadata = { title: "Sign-ups" };

export default async function Admin({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string }> }) {
  const { user } = await requireVendor();
  if (!isAdmin(user)) redirect("/app");
  const { msg, error } = await searchParams;
  const rows = listSignups();
  const accounts = listAccounts();
  const newAccounts = new Set(accountsWaiting(accounts).map((a) => a.id));
  const waiting = rows.filter((r) => !r.contacted_at).length;

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <p className="eyebrow">Admin</p>
          <h1>Sign-ups</h1>
          <p className="muted">
            <b>{waiting}</b> early-access {waiting === 1 ? "request" : "requests"} and <b>{newAccounts.size}</b> new app {newAccounts.size === 1 ? "account" : "accounts"} waiting for you.
            Both are emailed to <b>{ALERT_TO()}</b>.
          </p>
        </div>
        <div className="row">
          <a className="btn btn-ghost" href="/app/admin/backups">Backups</a>
          {rows.length > 0 && <a className="btn btn-ghost" href="/app/admin/csv">Download CSV</a>}
        </div>
      </div>
      {msg && <p className="alert alert-ok" role="status">{msg}</p>}
      {error && <p className="alert alert-err" role="alert">{error}</p>}
      {!emailReady() && (
        <p className="alert alert-warn">Alert emails are off: set <code>SMTP_HOST</code>, <code>SMTP_USER</code> and <code>SMTP_PASS</code> in Render (for Google Workspace: <code>smtp.gmail.com</code>, your address and an app password). Sign-ups are still saved here.</p>
      )}

      <section className="card card-flush">
        <div className="card-head"><h2>Early-access requests</h2><span className="small muted">{rows.length} total · {waiting} waiting · from the form on the landing page</span></div>
        {rows.length === 0 ? <p className="empty">No sign-ups yet. They appear here as soon as someone submits the form on the landing page.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Received</th><th>Who</th><th>Business</th><th>Enquiries/wk</th><th>Contact</th><th>Alert</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const wa = whatsappLink(r.whatsapp);
                  return (
                    <tr key={r.id} style={r.contacted_at ? { opacity: 0.6 } : undefined}>
                      <td className="small">{formatDateTime(r.created_at)}</td>
                      <td><b>{r.name}</b>{!r.contacted_at && <> <span className="badge badge-brand">New</span></>}</td>
                      <td>{r.business}<div className="small muted">{r.vendor_type}</div></td>
                      <td className="small">{r.enquiries_per_week}</td>
                      <td className="small">
                        {r.email && <div><a href={`mailto:${r.email}`}>{r.email}</a></div>}
                        {r.whatsapp && <div>{wa ? <a href={wa} target="_blank" rel="noopener">{r.whatsapp}</a> : r.whatsapp}</div>}
                      </td>
                      <td className="small">
                        {r.notified_at ? <span className="badge badge-ok">Emailed</span>
                          : r.notify_error ? <span className="badge badge-red" title={r.notify_error}>Failed</span>
                          : <span className="badge">Not sent</span>}
                        {!r.notified_at && emailReady() && (
                          <form action={resendAlertAction} style={{ marginTop: 6 }}>
                            <input type="hidden" name="id" value={r.id} />
                            <button className="btn btn-ghost btn-sm" type="submit">Send alert</button>
                          </form>
                        )}
                      </td>
                      <td>
                        <form action={toggleContactedAction}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="contacted" value={r.contacted_at ? "0" : "1"} />
                          <button className={`btn btn-sm ${r.contacted_at ? "btn-ghost" : "btn-primary"}`} type="submit">
                            {r.contacted_at ? "Contacted ✓" : "Mark contacted"}
                          </button>
                        </form>
                      </td>
                      <td>
                        <form action={deleteSignupAction}>
                          <input type="hidden" name="id" value={r.id} />
                          <ConfirmSubmit message={`Delete ${r.name || "this sign-up"}${r.business ? ` (${r.business})` : ""}? This can't be undone.`}>Delete</ConfirmSubmit>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card card-flush" id="accounts">
        <div className="card-head">
          <h2>App accounts</h2>
          <span className="small muted">{accounts.length} total · {newAccounts.size} waiting · created at /signup, not through the early-access form</span>
        </div>
        {accounts.length === 0 ? <p className="empty">No accounts yet.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Created</th><th>Who</th><th>Business</th><th>Email</th><th>Price list</th><th>Enquiries</th><th>Status</th></tr></thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} style={newAccounts.has(a.id) ? undefined : { opacity: 0.6 }}>
                    <td className="small">{formatDateTime(a.created_at)}</td>
                    <td><b>{a.name}</b>{newAccounts.has(a.id) && <> <span className="badge badge-brand">New</span></>}</td>
                    <td>{a.business}<div className="small muted">{kindLabel(a.kind)}</div></td>
                    <td className="small"><a href={`mailto:${a.email}`}>{a.email}</a></td>
                    <td className="small">{a.live_items ? `${a.live_items} live items` : <span className="muted">Not set up</span>}</td>
                    <td className="small mono">{a.enquiries}</td>
                    <td>
                      {isAdmin(a) ? <span className="small muted">Admin</span> : (
                        <form action={toggleAccountContactedAction}>
                          <input type="hidden" name="id" value={a.id} />
                          <input type="hidden" name="contacted" value={a.admin_contacted_at ? "0" : "1"} />
                          <button className={`btn btn-sm ${a.admin_contacted_at ? "btn-ghost" : "btn-primary"}`} type="submit">
                            {a.admin_contacted_at ? "Contacted ✓" : "Mark contacted"}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
