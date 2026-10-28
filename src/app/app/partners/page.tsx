import Link from "next/link";
import { requireVendor } from "@/lib/auth";
import { all } from "@/lib/db";
import { kindLabel, sharedFromPrice } from "@/lib/engine";
import { fmtMoney } from "@/lib/pricing";
import { formatDateTime } from "@/lib/dates";
import { invitePartnerAction, respondPartnerAction } from "../actions";
import { CopyButton } from "@/components/copy-button";

export const metadata = { title: "Partners" };

export default async function Partners({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string }> }) {
  const { vendor } = await requireVendor();
  const { msg, error } = await searchParams;
  const rows = all<{ id: number; status: string; requester_id: number; vid: number; name: string; kind: string; share_from_price: number }>(
    `SELECT p.id, p.status, p.requester_id, v.id vid, v.name, v.kind, v.share_from_price
     FROM partnerships p JOIN vendors v ON v.id = CASE WHEN p.requester_id = ? THEN p.partner_id ELSE p.requester_id END
     WHERE (p.requester_id = ? OR p.partner_id = ?) AND p.status != 'declined' ORDER BY p.status, v.name`,
    vendor.id, vendor.id, vendor.id,
  );
  // Only a starting price the partner chose to share; never their price list.
  const accepted = rows.filter((r) => r.status === "accepted").map((r) => ({ ...r, from: sharedFromPrice({ id: r.vid, share_from_price: r.share_from_price }) }));
  const incoming = rows.filter((r) => r.status === "pending" && r.requester_id !== vendor.id);
  const outgoing = rows.filter((r) => r.status === "pending" && r.requester_id === vendor.id);
  const referrals = all<{ id: number; status: string; fee_amount: number | null; created_at: string; dir: string; partner: string; source_enquiry: number; target_enquiry: number; contact: string | null }>(
    `SELECT r.*, CASE WHEN r.from_vendor = ? THEN 'out' ELSE 'in' END dir, v.name partner, e.contact_name contact
     FROM referrals r JOIN vendors v ON v.id = CASE WHEN r.from_vendor = ? THEN r.to_vendor ELSE r.from_vendor END
     JOIN enquiries e ON e.id = r.source_enquiry
     WHERE r.from_vendor = ? OR r.to_vendor = ? ORDER BY r.id DESC LIMIT 50`,
    vendor.id, vendor.id, vendor.id, vendor.id,
  );

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <p className="eyebrow">The Match network</p>
          <h1>Partners</h1>
          <p className="muted">Vendors you trust. Matchire suggests them in quotes and lets you pass on dates you can&apos;t take.</p>
        </div>
      </div>
      {msg && <p className="alert alert-ok" role="status">{msg}</p>}
      {error && <p className="alert alert-err" role="alert">{error}</p>}

      <div className="two-col">
        <section className="card card-flush">
          <div className="card-head"><h2>Your partners</h2></div>
          {accepted.length === 0 ? <p className="empty">No partners yet. Invite vendors you already work with.</p> : (
            <table>
              <thead><tr><th>Vendor</th><th>Type</th><th>From</th><th /></tr></thead>
              <tbody>
                {accepted.map((p) => (
                  <tr key={p.id}>
                    <td><b>{p.name}</b></td>
                    <td>{kindLabel(p.kind)}</td>
                    <td className={p.from ? "mono small" : "small muted"}>{p.from ? `${fmtMoney(p.from.price)}${p.from.unit}` : "Not shared"}</td>
                    <td><form action={respondPartnerAction}><input type="hidden" name="id" value={p.id} /><button className="btn btn-ghost btn-sm" name="intent" value="remove" type="submit">Remove</button></form></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <div className="stack">
          <section className="card stack">
            <h2>Invite a partner</h2>
            <p className="small muted">Ask them for their partner code (it&apos;s on their Partners page), or share yours.</p>
            <div className="row"><span className="code">{vendor.slug}</span><CopyButton text={vendor.slug} label="Copy my code" /></div>
            <form action={invitePartnerAction} className="row">
              <input name="code" required placeholder="Their partner code" className="grow" aria-label="Partner code" />
              <button className="btn btn-primary btn-sm" type="submit">Send request</button>
            </form>
          </section>
          {(incoming.length > 0 || outgoing.length > 0) && (
            <section className="card stack">
              <h2>Requests</h2>
              {incoming.map((p) => (
                <form key={p.id} action={respondPartnerAction} className="row between">
                  <input type="hidden" name="id" value={p.id} />
                  <span><b>{p.name}</b> <span className="muted small">· {kindLabel(p.kind)}</span></span>
                  <span className="row">
                    <button className="btn btn-primary btn-sm" name="intent" value="accept" type="submit">Accept</button>
                    <button className="btn btn-ghost btn-sm" name="intent" value="decline" type="submit">Decline</button>
                  </span>
                </form>
              ))}
              {outgoing.map((p) => <p key={p.id} className="small muted">Waiting for {p.name} to accept.</p>)}
            </section>
          )}
          <section className="card stack small">
            <h3>How suggestions work</h3>
            <p className="muted">When a wedding, party or corporate event needs something you don&apos;t offer, Matchire can mention a partner and their starting price in your quote. Your partners only ever see enquiries you refer to them. You earn {vendor.referral_fee_pct}% of the booking value on referrals that book (change this in <Link href="/app/settings">Settings</Link>).</p>
          </section>
        </div>
      </div>

      <section className="card card-flush">
        <div className="card-head"><h2>Referrals</h2></div>
        {referrals.length === 0 ? <p className="empty">No referrals yet.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Planner</th><th>Direction</th><th>Status</th><th>Fee</th></tr></thead>
              <tbody>
                {referrals.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{formatDateTime(r.created_at)}</td>
                    <td><Link href={`/app/inbox/${r.dir === "out" ? r.source_enquiry : r.target_enquiry}`}>{r.contact || "Enquiry"}</Link></td>
                    <td>{r.dir === "out" ? `To ${r.partner}` : `From ${r.partner}`}</td>
                    <td><span className={`badge ${r.status === "won" ? "badge-ok" : ""}`}>{r.status === "won" ? "Booked" : r.status === "lost" ? "Lost" : "Open"}</span></td>
                    <td className="mono small">{r.fee_amount != null ? `${r.dir === "out" ? "+" : "−"}${fmtMoney(r.fee_amount)}` : "–"}</td>
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
