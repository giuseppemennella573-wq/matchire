import { requireAdmin } from "@/lib/auth";
import { PRICES, usageSummary, type UsageLine } from "@/lib/ai-usage";
import { aiEnabled } from "@/lib/ai";

export const metadata = { title: "AI usage" };

const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function Row({ label, l }: { label: React.ReactNode; l: UsageLine }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="mono small">{l.calls}{l.errors ? <span className="muted"> ({l.errors} failed)</span> : null}</td>
      <td className="mono small">{l.enquiries}</td>
      <td className="mono small">{k(l.input)} / {k(l.output)}</td>
      <td className="mono small">{k(l.cacheRead)} / {k(l.cacheWrite)}</td>
      <td className="mono"><b>{usd(l.cost)}</b></td>
      <td className="mono small">{l.enquiries ? usd(l.cost / l.enquiries) : "–"}</td>
    </tr>
  );
}

function Table({ title, rows }: { title: string; rows: { key: string; label: React.ReactNode; l: UsageLine }[] }) {
  return (
    <section className="card card-flush">
      <div className="card-head"><h2>{title}</h2></div>
      {rows.length === 0 ? <p className="empty">No AI calls in this period.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th /><th>Calls</th><th>Enquiries</th><th>Tokens in / out</th><th>Cache read / write</th><th>Cost (USD)</th><th>Per enquiry</th></tr></thead>
            <tbody>{rows.map((r) => <Row key={r.key} label={r.label} l={r.l} />)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function AiUsage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  await requireAdmin();
  const { period } = await searchParams;
  const now = new Date();
  const month = period === "month";
  const since = month ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) : new Date(now.getTime() - 30 * 86400_000);
  const s = usageSummary(since);

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <p className="eyebrow">Matchire admin</p>
          <h1>AI usage</h1>
          <p className="muted">What Claude costs: every call to read an enquiry, draft a reply or import a price list. Tokens only; no message content is stored. Demo accounts are left out of the totals.</p>
        </div>
        <div className="row">
          <a className={`btn btn-sm ${month ? "btn-ghost" : "btn-primary"}`} href="/app/admin/ai-usage">Last 30 days</a>
          <a className={`btn btn-sm ${month ? "btn-primary" : "btn-ghost"}`} href="/app/admin/ai-usage?period=month">This month</a>
        </div>
      </div>
      {!aiEnabled() && <p className="alert alert-warn">No Anthropic API key is set, so Matchire runs in rules mode and makes no AI calls.</p>}

      <div className="grid3">
        <section className="card stack" style={{ gap: 4 }}><span className="small muted">Total cost</span><b style={{ fontSize: 28 }}>{usd(s.total.cost)}</b></section>
        <section className="card stack" style={{ gap: 4 }}><span className="small muted">Per enquiry</span><b style={{ fontSize: 28 }}>{s.perEnquiry == null ? "–" : usd(s.perEnquiry)}</b></section>
        <section className="card stack" style={{ gap: 4 }}><span className="small muted">AI calls</span><b style={{ fontSize: 28 }}>{s.total.calls}</b><span className="small muted">{s.total.enquiries} enquiries</span></section>
      </div>
      {s.unpricedCalls > 0 && <p className="alert alert-warn">{s.unpricedCalls} calls used a model with no price set in <code>src/lib/ai-usage.ts</code>, so they aren&apos;t in the cost.</p>}

      <Table title="By vendor" rows={s.byVendor.map((v) => ({ key: String(v.vendorId), label: v.name, l: v }))} />
      <Table title="By purpose" rows={s.byPurpose.map((p) => ({ key: p.purpose, label: { extract: "Reading enquiries", draft: "Drafting replies", import: "Importing price lists" }[p.purpose] ?? p.purpose, l: p }))} />
      <Table title="By model" rows={s.byModel.map((m) => ({ key: m.model, label: <span className="mono small">{m.model}</span>, l: m }))} />
      <Table title="Demo accounts (not in the totals)" rows={s.demo.calls ? [{ key: "demo", label: "Demo", l: s.demo }] : []} />

      <p className="small muted">Prices per million tokens: {Object.entries(PRICES).map(([m, p]) => `${m} $${p.input} in / $${p.output} out`).join(" · ")}. Anthropic list prices; set in src/lib/ai-usage.ts.</p>
    </div>
  );
}
