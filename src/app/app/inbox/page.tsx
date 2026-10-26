import Link from "next/link";
import { requireVendor } from "@/lib/auth";
import { all } from "@/lib/db";
import { parseDetails, parseQuote } from "@/lib/engine";
import { fmtMoney } from "@/lib/pricing";
import { formatDate, formatDateTime } from "@/lib/dates";
import { CHANNEL_LABEL, STATUS_LABEL, type Channel, type Enquiry, type EnquiryStatus } from "@/lib/types";
import { newEnquiryAction } from "../actions";
import { Submit } from "@/components/submit";

export const metadata = { title: "Inbox" };

const FILTERS = [
  { key: "attention", label: "Needs you" },
  { key: "open", label: "Open" },
  { key: "won", label: "Booked" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
] as const;

const STATUS_BADGE: Record<EnquiryStatus, string> = {
  new: "badge-brand", awaiting_info: "badge-amber", quoted: "", won: "badge-ok", lost: "", referred: "", expired: "",
};

export default async function Inbox({ searchParams }: { searchParams: Promise<{ filter?: string; error?: string; msg?: string }> }) {
  const { vendor } = await requireVendor();
  const { filter = "open", error, msg } = await searchParams;
  const where =
    filter === "attention" ? "AND EXISTS (SELECT 1 FROM messages d WHERE d.enquiry_id = e.id AND d.status = 'draft')"
    : filter === "won" ? "AND e.status = 'won'"
    : filter === "closed" ? "AND e.status IN ('lost','referred','expired')"
    : filter === "all" ? ""
    : "AND e.status IN ('new','awaiting_info','quoted')";
  const rows = all<Enquiry & { last: string; has_draft: number }>(
    `SELECT e.*, (SELECT body FROM messages m WHERE m.enquiry_id = e.id AND m.direction = 'in' ORDER BY id DESC LIMIT 1) last,
            EXISTS (SELECT 1 FROM messages d WHERE d.enquiry_id = e.id AND d.status = 'draft') has_draft
     FROM enquiries e WHERE e.vendor_id = ? ${where} ORDER BY e.updated_at DESC LIMIT 200`,
    vendor.id,
  );

  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Inbox</h1>
        <nav className="filters" aria-label="Filter enquiries">
          {FILTERS.map((f) => <Link key={f.key} href={`/app/inbox?filter=${f.key}`} aria-current={filter === f.key ? "page" : undefined}>{f.label}</Link>)}
        </nav>
      </div>
      {msg && <p className="alert alert-ok" role="status">{msg}</p>}
      {error && <p className="alert alert-err" role="alert">{error}</p>}

      <section className="card card-flush">
        {rows.length === 0 ? (
          <p className="empty">No enquiries here yet. They arrive from WhatsApp, email and your enquiry form, or you can paste one below.</p>
        ) : rows.map((e) => {
          const d = parseDetails(e);
          const q = parseQuote(e);
          return (
            <Link key={e.id} href={`/app/inbox/${e.id}`} className="list-row">
              <span className={`dot dot-${e.lead ?? "warm"}`} title={e.lead ? `${e.lead} lead` : undefined} />
              <div className="grow stack" style={{ gap: 4 }}>
                <div className="row">
                  <b>{e.contact_name || e.contact_handle || `Enquiry #${e.id}`}</b>
                  <span className={`badge ${STATUS_BADGE[e.status]}`}>{STATUS_LABEL[e.status]}</span>
                  {e.has_draft ? <span className="badge badge-brand">Reply ready</span> : null}
                  <span className="badge">{CHANNEL_LABEL[e.channel as Channel]}</span>
                </div>
                <p className="preview">{e.last}</p>
                <p className="small muted">{[d.event_date && formatDate(d.event_date), d.pax && `${d.pax} pax`, q?.total ? fmtMoney(q.total) : null].filter(Boolean).join(" · ")}</p>
              </div>
              <span className="small muted">{formatDateTime(e.updated_at)}</span>
            </Link>
          );
        })}
      </section>

      <section className="card stack" id="new">
        <div className="stack" style={{ gap: 4 }}>
          <h2>Add an enquiry</h2>
          <p className="muted small">Paste a message from Instagram, a call or anywhere Matchire isn&apos;t connected yet. It gets read, priced and drafted like any other.</p>
        </div>
        <form action={newEnquiryAction} className="stack">
          <label className="field"><span>Planner&apos;s message</span><textarea name="text" rows={4} required placeholder="Hi! Looking for a photobooth for my daughter's 21st on Sat 15 Nov, evening, about 80 guests…" /></label>
          <div className="grid3">
            <label className="field"><span>Channel</span>
              <select name="channel" defaultValue="manual">
                <option value="whatsapp">WhatsApp</option><option value="instagram">Instagram</option><option value="email">Email</option><option value="manual">Phone / other</option>
              </select>
            </label>
            <label className="field"><span>Name (optional)</span><input name="name" /></label>
            <label className="field"><span>Phone or email (optional)</span><input name="contact" placeholder="+65 9123 4567" /></label>
          </div>
          <div><Submit pending="Reading and drafting…">Draft a reply</Submit></div>
        </form>
      </section>
    </div>
  );
}
