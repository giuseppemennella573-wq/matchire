import Link from "next/link";
import { requireVendor } from "@/lib/auth";
import { all } from "@/lib/db";
import { countFiled, parseDetails, parseQuote } from "@/lib/engine";
import { qualifySummary } from "@/lib/qualify";
import { fmtMoney } from "@/lib/pricing";
import { formatDateTime } from "@/lib/dates";
import { CHANNEL_LABEL, OPEN_STATUSES, STATUS_LABEL, type Channel, type Enquiry, type EnquiryStatus } from "@/lib/types";
import { newEnquiryAction } from "../actions";
import { Submit } from "@/components/submit";

export const metadata = { title: "Inbox" };

const FILTERS = [
  { key: "attention", label: "Needs you" },
  { key: "open", label: "Open" },
  { key: "won", label: "Booked" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
  { key: "other", label: "Other" },
] as const;

const STATUS_BADGE: Record<EnquiryStatus, string> = {
  new: "badge-brand", awaiting_info: "badge-amber", quoted: "", won: "badge-ok", lost: "", referred: "", expired: "", other: "",
};

import { clientHistory, clientNote } from "@/lib/clients";

/** A booked client wrote again: no draft, but the vendor needs to see it. */
const BOOKED_WROTE = "(e.status = 'won' AND e.owner_reason LIKE 'Message from a booked client%')";

export default async function Inbox({ searchParams }: { searchParams: Promise<{ filter?: string; error?: string; msg?: string }> }) {
  const { vendor } = await requireVendor();
  const { filter = "open", error, msg } = await searchParams;
  const where =
    filter === "attention" ? `AND (EXISTS (SELECT 1 FROM messages d WHERE d.enquiry_id = e.id AND d.status = 'draft') OR ${BOOKED_WROTE})`
    : filter === "won" ? "AND e.status = 'won'"
    : filter === "closed" ? "AND e.status IN ('lost','referred','expired')"
    : filter === "other" ? "AND e.status = 'other'"
    : filter === "all" ? "AND e.status <> 'other'"
    : `AND (e.status IN ('new','awaiting_info','quoted') OR ${BOOKED_WROTE})`;
  const filed = countFiled(vendor.id);
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
      {filter !== "other" && filed > 0 && (
        <p className="small muted">{filed} message{filed === 1 ? "" : "s"} filed under Other this week (not booking enquiries, so no replies). <Link href="/app/inbox?filter=other">Review</Link></p>
      )}

      <section className="card card-flush">
        {rows.length === 0 ? (
          <p className="empty">No enquiries here yet. They arrive from WhatsApp, email and your enquiry form, or you can paste one below.</p>
        ) : rows.map((e) => {
          const d = parseDetails(e);
          const q = parseQuote(e);
          const regular = clientHistory(e);
          return (
            <Link key={e.id} href={`/app/inbox/${e.id}`} className="list-row">
              <span className={`dot dot-${e.lead ?? "warm"}`} title={e.lead ? `${e.lead} lead` : undefined} />
              <div className="grow stack" style={{ gap: 4 }}>
                <div className="row">
                  <b>{e.contact_name || e.contact_handle || `Enquiry #${e.id}`}</b>
                  <span className={`badge ${STATUS_BADGE[e.status]}`}>{STATUS_LABEL[e.status]}</span>
                  {e.has_draft ? <span className="badge badge-brand">Reply ready</span> : null}
                  {e.status === "won" && e.owner_reason?.startsWith("Message from a booked client") && <span className="badge badge-amber">Booked client wrote</span>}
                  {e.fishing_reason && <span className="badge badge-amber" title={e.fishing_reason}>Possible price-fishing</span>}
                  {d.undecided && OPEN_STATUSES.includes(e.status) && <span className="badge badge-amber">Undecided</span>}
                  {d.intent === "price_concern" && OPEN_STATUSES.includes(e.status) && <span className="badge badge-amber">Price concern</span>}
                  {regular && <span className={`badge ${regular.verified ? "badge-ok" : ""}`} title={clientNote(regular)}>{regular.bookings ? "Regular client" : "Enquired before"}</span>}
                  <span className="badge">{CHANNEL_LABEL[e.channel as Channel]}</span>
                  {e.status === "other" && e.filed_reason && <span className="small muted">{e.filed_reason}</span>}
                  {e.status !== "other" && e.filed_reason && <span className="badge badge-amber" title={e.filed_reason}>Check this</span>}
                </div>
                <p className="preview">{e.last}</p>
                <p className="small muted">{[qualifySummary(d), q?.total ? fmtMoney(q.total) : null].filter(Boolean).join(" · ")}</p>
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
