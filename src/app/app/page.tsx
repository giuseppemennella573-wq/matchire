import Link from "next/link";
import { requireVendor } from "@/lib/auth";
import { all } from "@/lib/db";
import { stats, getItems } from "@/lib/engine";
import { fmtMoney } from "@/lib/pricing";
import { formatDate, formatDateTime, sgToday } from "@/lib/dates";
import { CHANNEL_LABEL, type Channel, type Enquiry, type Hold } from "@/lib/types";
import { whatsappReady } from "@/lib/channels";
import { aiEnabled } from "@/lib/ai";

export const metadata = { title: "Overview" };

function mins(m: number | null) {
  if (m == null) return "–";
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  if (m < 60 * 24) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
}

export default async function Overview({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { vendor } = await requireVendor();
  const { welcome } = await searchParams;
  const s = stats(vendor.id);
  const attention = all<Enquiry & { draft: string }>(
    `SELECT e.*, m.body draft FROM enquiries e JOIN messages m ON m.enquiry_id = e.id AND m.status = 'draft'
     WHERE e.vendor_id = ? GROUP BY e.id ORDER BY e.updated_at DESC LIMIT 8`,
    vendor.id,
  );
  const holds = all<Hold & { contact_name: string | null }>(
    `SELECT h.*, e.contact_name FROM holds h LEFT JOIN enquiries e ON e.id = h.enquiry_id
     WHERE h.vendor_id = ? AND h.status = 'active' AND h.kind IN ('hold','booking') AND h.date >= ? ORDER BY h.date LIMIT 8`,
    vendor.id, sgToday(),
  );
  const items = getItems(vendor.id);
  const setup = [
    { done: items.some((i) => i.active), label: "Load your price list", href: "/app/prices" },
    { done: whatsappReady(vendor), label: "Connect WhatsApp Business", href: "/app/settings#channels" },
    { done: s.enquiries > 0, label: "Share your enquiry form or paste a first enquiry", href: "/app/inbox" },
    { done: aiEnabled(), label: "Turn on AI drafting (Claude API key)", href: "/app/settings#ai" },
  ];

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <p className="eyebrow">Last 30 days</p>
          <h1>{welcome ? `Welcome, ${vendor.name}` : "Overview"}</h1>
        </div>
        <Link className="btn btn-primary" href="/app/inbox#new">Add an enquiry</Link>
      </div>

      {setup.some((x) => !x.done) && (
        <section className="card stack">
          <h2>Get set up</h2>
          <ol className="stack" style={{ margin: 0, paddingLeft: 20 }}>
            {setup.map((x) => (
              <li key={x.label} className={x.done ? "muted" : ""}>
                {x.done ? <s>{x.label}</s> : <Link href={x.href}>{x.label}</Link>}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="kpis" aria-label="Key numbers">
        <div className="card kpi"><span>Enquiries</span><b className="mono">{s.enquiries}</b></div>
        <div className="card kpi"><span>Median first reply</span><b className="mono">{mins(s.medianResponseMins)}</b></div>
        <div className="card kpi"><span>Booked</span><b className="mono">{s.booked}</b><span>{(s.conversion * 100).toFixed(0)}% of enquiries</span></div>
        <div className="card kpi"><span>Booked value</span><b className="mono">{fmtMoney(s.bookedValue)}</b>{s.referralFees > 0 && <span>+ {fmtMoney(s.referralFees)} referral fees</span>}</div>
      </section>

      <div className="two-col">
        <section className="card card-flush">
          <div className="card-head"><h2>Needs you</h2><Link className="small" href="/app/inbox?filter=attention">See all</Link></div>
          {attention.length === 0 ? (
            <p className="empty">Nothing waiting. New replies Matchire drafts for your approval show up here.</p>
          ) : (
            attention.map((e) => (
              <Link key={e.id} href={`/app/inbox/${e.id}`} className="list-row">
                <span className={`dot dot-${e.lead ?? "warm"}`} />
                <div className="grow">
                  <div className="row"><b>{e.contact_name || e.contact_handle || `Enquiry #${e.id}`}</b><span className="badge">{CHANNEL_LABEL[e.channel as Channel]}</span></div>
                  <p className="preview">{e.owner_reason || e.draft}</p>
                </div>
                <span className="small muted">{formatDateTime(e.updated_at)}</span>
              </Link>
            ))
          )}
        </section>

        <div className="stack">
          <section className="card card-flush">
            <div className="card-head"><h2>Coming up</h2><Link className="small" href="/app/calendar">Calendar</Link></div>
            {holds.length === 0 ? <p className="empty">No holds or bookings yet.</p> : (
              <table>
                <tbody>
                  {holds.map((h) => (
                    <tr key={h.id}>
                      <td className="mono small">{formatDate(h.date)}</td>
                      <td>{h.enquiry_id ? <Link href={`/app/inbox/${h.enquiry_id}`}>{h.contact_name || h.note}</Link> : h.note}</td>
                      <td>{h.kind === "booking" ? <span className="badge badge-leaf">Booked</span> : <span className="badge badge-amber">Held until {formatDateTime(h.expires_at)}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="card card-flush">
            <div className="card-head"><h2>By channel</h2></div>
            {s.byChannel.length === 0 ? <p className="empty">No enquiries yet.</p> : (
              <table>
                <thead><tr><th>Channel</th><th>Enquiries</th><th>Booked</th><th>Value</th></tr></thead>
                <tbody>
                  {s.byChannel.map((c) => (
                    <tr key={c.channel}><td>{CHANNEL_LABEL[c.channel as Channel] ?? c.channel}</td><td className="mono">{c.total}</td><td className="mono">{c.won}</td><td className="mono">{fmtMoney(c.value)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
