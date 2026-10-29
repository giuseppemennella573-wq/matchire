import { redirect } from "next/navigation";
import { requireVendor } from "@/lib/auth";
import { accountsWaiting, ALERT_TO, isAdmin, listAccounts } from "@/lib/early-access";
import { kindLabel } from "@/lib/engine";
import { formatDateTime } from "@/lib/dates";
import { deleteAccountAction, toggleAccountContactedAction } from "../actions";
import { ConfirmSubmit } from "@/components/confirm-submit";

export const metadata = { title: "Accounts" };

export default async function Accounts({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string }> }) {
  const { user } = await requireVendor();
  if (!isAdmin(user)) redirect("/app");
  const { msg, error } = await searchParams;
  const accounts = listAccounts();
  const newAccounts = new Set(accountsWaiting(accounts).map((a) => a.id));

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <p className="eyebrow">Matchire admin</p>
          <h1>Accounts</h1>
          <p className="muted"><b>{newAccounts.size}</b> new {newAccounts.size === 1 ? "account" : "accounts"} waiting for you. Vendors who signed up at /signup, not through the early-access form. New ones are emailed to <b>{ALERT_TO()}</b>.</p>
        </div>
      </div>
      {msg && <p className="alert alert-ok" role="status">{msg}</p>}
      {error && <p className="alert alert-err" role="alert">{error}</p>}

      <section className="card card-flush">
        <div className="card-head">
          <h2>All accounts</h2>
          <span className="small muted">{accounts.length} total · {newAccounts.size} waiting</span>
        </div>
        {accounts.length === 0 ? <p className="empty">No accounts yet.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Created</th><th>Who</th><th>Business</th><th>Email</th><th>Price list</th><th>Enquiries</th><th>Status</th><th /></tr></thead>
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
                    <td>
                      {!isAdmin(a) && (
                        <form action={deleteAccountAction}>
                          <input type="hidden" name="id" value={a.id} />
                          <ConfirmSubmit message={`Delete ${a.business} (${a.email})? This removes the account and everything in it: price list, enquiries, calendar, partners and referrals. Their login stops working. This can't be undone.`}>Delete</ConfirmSubmit>
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
