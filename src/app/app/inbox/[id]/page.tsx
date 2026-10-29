import Link from "next/link";
import { notFound } from "next/navigation";
import { requireVendor } from "@/lib/auth";
import { all, get } from "@/lib/db";
import * as E from "@/lib/engine";
import { fmtMoney } from "@/lib/pricing";
import { formatDate, formatDateTime } from "@/lib/dates";
import { CHANNEL_LABEL, STATUS_LABEL, type Hold, type Vendor } from "@/lib/types";
import { deleteEnquiryAction, draftAction, noteAction, outcomeAction, plannerReplyAction, referAction, releaseHoldAction } from "../../actions";
import { CopyButton } from "@/components/copy-button";
import { Submit } from "@/components/submit";
import { ConfirmSubmit } from "@/components/confirm-submit";

export const metadata = { title: "Enquiry" };

const PURPOSE_LABEL: Record<string, string> = {
  quote: "Quote", ask_info: "Asks for details", answer: "Answer", confirm: "Booking confirmation", unavailable: "Date unavailable",
  over_capacity: "Over capacity", referred: "Referral note", followup: "Follow-up", last_call: "Last call",
  phone_reply: "from your WhatsApp app",
};

export default async function EnquiryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; error?: string }> }) {
  const { vendor } = await requireVendor();
  const { id } = await params;
  const { msg, error } = await searchParams;
  const e = E.getEnquiry(vendor.id, Number(id));
  if (!e) notFound();
  const d = E.parseDetails(e);
  const q = E.parseQuote(e);
  const messages = E.getMessages(e.id).filter((m) => m.status !== "discarded" && m.status !== "draft");
  const draft = E.pendingDraft(e.id);
  const items = E.getItems(vendor.id);
  const pkg = items.find((i) => i.id === d.package_id);
  const addons = items.filter((i) => d.addon_ids.includes(i.id));
  const holds = all<Hold>("SELECT * FROM holds WHERE enquiry_id = ? ORDER BY id DESC", e.id);
  const activeHold = holds.find((h) => h.status === "active");
  const partners = E.acceptedPartners(vendor.id);
  const referral = get<{ status: string; fee_amount: number | null; name: string; dir: string }>(
    `SELECT r.status, r.fee_amount, v.name, CASE WHEN r.source_enquiry = ? THEN 'to' ELSE 'from' END dir FROM referrals r
     JOIN vendors v ON v.id = CASE WHEN r.source_enquiry = ? THEN r.to_vendor ELSE r.from_vendor END
     WHERE r.source_enquiry = ? OR r.target_enquiry = ? LIMIT 1`,
    e.id, e.id, e.id, e.id,
  );
  const referredFrom = e.referred_from ? get<Vendor>("SELECT * FROM vendors WHERE id = ?", e.referred_from) : null;
  const open = ["new", "awaiting_info", "quoted", "expired"].includes(e.status);
  const missing = [!d.event_date && "Date", !d.pax && "Headcount", !d.slot && !d.start_time && vendor.kind !== "caterer" && "Start time"].filter(Boolean) as string[];

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <Link href="/app/inbox" className="small muted">← Inbox</Link>
          <h1>{e.contact_name || e.contact_handle || `Enquiry #${e.id}`}</h1>
          <div className="row small">
            <span className="badge">{CHANNEL_LABEL[e.channel]}</span>
            <span className="badge">{STATUS_LABEL[e.status]}</span>
            {e.lead && <span className="badge"><span className={`dot dot-${e.lead}`} /> {e.lead === "hot" ? "Hot lead" : e.lead === "warm" ? "Needs info" : "Unlikely"}</span>}
            {e.contact_handle && <span className="muted">{e.contact_handle}</span>}
            {e.contact_email && e.contact_email !== e.contact_handle && <span className="muted">{e.contact_email}</span>}
          </div>
        </div>
      </div>
      {msg && <p className="alert alert-ok" role="status">{msg}</p>}
      {error && <p className="alert alert-err" role="alert">{error}</p>}

      <div className="convo-grid">
        <section className="card card-flush">
          <div className="thread" aria-label="Conversation">
            {referredFrom && <div className="bubble bubble-note">Referred to you by your partner {referredFrom.name}.</div>}
            {messages.map((m) => (
              <div key={m.id} className={`bubble ${m.direction === "in" ? "bubble-in" : m.direction === "out" ? "bubble-out" : "bubble-note"}`}>
                {m.body}
                <div className="bubble-meta">
                  {formatDateTime(m.sent_at || m.created_at)}
                  {m.direction === "out" && (m.status === "manual" ? " · sent by you" : m.status === "failed" ? ` · failed: ${m.error}` : " · sent")}
                  {m.purpose && m.direction === "out" ? ` · ${PURPOSE_LABEL[m.purpose] ?? m.purpose}` : ""}
                </div>
              </div>
            ))}
          </div>

          {draft ? (
            <form action={draftAction} className="composer">
              <input type="hidden" name="messageId" value={draft.id} />
              <input type="hidden" name="enquiryId" value={e.id} />
              <div className="row between">
                <h2>Drafted reply <span className="badge badge-brand">{PURPOSE_LABEL[draft.purpose ?? "quote"]}</span></h2>
                <span className="small muted">{draft.template ? "WhatsApp template: sent exactly as approved" : "Edit freely before sending"}</span>
              </div>
              {e.owner_reason && <p className="alert alert-warn">{e.owner_reason}</p>}
              <label className="field"><span className="hide">Reply</span><textarea id="draft-body" name="body" defaultValue={draft.body} readOnly={!!draft.template} /></label>
              <div className="row">
                {draft.purpose === "confirm" ? (
                  <Submit name="intent" value="send_book" pending="Sending…">Send &amp; mark booked</Submit>
                ) : (
                  <Submit name="intent" value="send" pending="Sending…">Send reply</Submit>
                )}
                <Submit className="btn btn-ghost" name="intent" value="manual">I sent it myself</Submit>
                <CopyButton target="draft-body" />
                <Submit className="btn btn-ghost btn-sm" name="intent" value="regenerate" pending="Redrafting…">Redraft</Submit>
                <Submit className="btn btn-danger btn-sm" name="intent" value="discard">Discard</Submit>
              </div>
            </form>
          ) : open ? (
            <form action={outcomeAction} className="composer">
              <input type="hidden" name="enquiryId" value={e.id} />
              <div className="row between">
                <p className="muted small">No reply waiting. Matchire drafts one when the planner writes back{e.next_followup_at ? `, and a follow-up is scheduled for ${formatDateTime(e.next_followup_at)}` : ""}.</p>
                <Submit className="btn btn-ghost btn-sm" name="intent" value="reprocess" pending="Drafting…">Draft a reply now</Submit>
              </div>
            </form>
          ) : null}

          <details className="more composer">
            <summary>Log a message from the planner</summary>
            <form action={plannerReplyAction} className="stack">
              <input type="hidden" name="enquiryId" value={e.id} />
              <p className="small muted">For replies that came in somewhere Matchire isn&apos;t connected, like a call or Instagram. Matchire drafts the next reply.</p>
              <textarea name="text" rows={3} required />
              <div><Submit className="btn btn-ghost btn-sm" pending="Drafting…">Add and draft reply</Submit></div>
            </form>
          </details>
        </section>

        <aside className="stack">
          <section className="card stack">
            <h2>What Matchire picked up</h2>
            {d.summary && <p>{d.summary}</p>}
            <dl className="facts">
              <dt>Date</dt><dd>{d.event_date ? `${formatDate(d.event_date)}${d.date_is_approximate ? " (approx.)" : ""}` : "–"}{d.date_text && <span className="muted small"> · “{d.date_text}”</span>}</dd>
              <dt>Time</dt><dd>{[d.slot?.replace("_", " "), d.start_time].filter(Boolean).join(", ") || "–"}{d.hours ? ` · ${d.hours}h` : ""}</dd>
              <dt>Guests</dt><dd>{d.pax ?? "–"}</dd>
              <dt>Budget</dt><dd>{d.budget ? fmtMoney(d.budget) : "–"}</dd>
              <dt>Event</dt><dd>{d.event_type?.replace("_", " ") ?? "–"}</dd>
              {d.location && <><dt>Where</dt><dd>{d.location}</dd></>}
              <dt>Package</dt><dd>{pkg?.name ?? "–"}{addons.length ? ` + ${addons.map((a) => a.name).join(", ")}` : ""}</dd>
            </dl>
            {(d.needs.length > 0 || missing.length > 0) && (
              <div className="tags">
                {d.needs.map((n) => <span key={n} className="tag">{n}</span>)}
                {missing.map((m) => <span key={m} className="tag tag-miss">{m} missing</span>)}
              </div>
            )}
            {d.questions.length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                <p className="small muted">Questions asked</p>
                <ul style={{ margin: 0, paddingLeft: 18 }} className="small">{d.questions.map((x) => <li key={x}>{x}</li>)}</ul>
              </div>
            )}
          </section>

          {q && q.lines.length > 0 && (
            <section className="card stack">
              <h2>Quote</h2>
              <div className="quote-box">
                {q.lines.map((l, i) => (
                  <div key={i} className="qline"><span>{l.label}</span><span className="mono">{l.full != null && <span className="strike">{fmtMoney(l.full)}</span>}{fmtMoney(l.amount)}</span></div>
                ))}
                <div className="qtotal"><span>Total</span><span className="mono">{fmtMoney(q.total)}</span></div>
              </div>
              {q.offpeak && <p className="small muted">Weekday daytime rate applied.</p>}
              {q.issues.map((x) => <p key={x} className="alert alert-warn small">{x}</p>)}
              <Link href="/app/prices" className="small muted">Built from your price list</Link>
            </section>
          )}

          {activeHold && (
            <section className="card stack">
              <h2>{activeHold.kind === "booking" ? "Booked" : "Date on hold"}</h2>
              <p>{formatDate(activeHold.date)}{activeHold.expires_at && <span className="muted"> · until {formatDateTime(activeHold.expires_at)}</span>}</p>
              <form action={releaseHoldAction}>
                <input type="hidden" name="holdId" value={activeHold.id} />
                <input type="hidden" name="back" value={`/app/inbox/${e.id}`} />
                <button className="btn btn-ghost btn-sm" type="submit">Release date</button>
              </form>
            </section>
          )}

          <section className="card stack">
            <h2>Outcome</h2>
            {referral && (
              <p className="small">
                {referral.dir === "to" ? `Referred to ${referral.name}` : `Referred by ${referral.name}`} · {referral.status}
                {referral.fee_amount ? ` · fee ${fmtMoney(referral.fee_amount)}` : ""}
              </p>
            )}
            {e.status === "won" ? (
              <p>Booked{e.won_value ? ` for ${fmtMoney(e.won_value)}` : ""}.</p>
            ) : open ? (
              <form action={outcomeAction} className="stack">
                <input type="hidden" name="enquiryId" value={e.id} />
                <label className="field"><span>Booking value (SGD)</span><input name="value" type="number" step="0.01" min="0" defaultValue={q?.total ?? ""} /></label>
                <div className="row">
                  <Submit name="intent" value="booked" className="btn btn-primary btn-sm">Mark booked</Submit>
                  <Submit name="intent" value="lost" className="btn btn-ghost btn-sm" formNoValidate>Mark lost</Submit>
                </div>
              </form>
            ) : (
              <form action={outcomeAction}>
                <input type="hidden" name="enquiryId" value={e.id} />
                <Submit name="intent" value="reopen" className="btn btn-ghost btn-sm">Reopen</Submit>
              </form>
            )}
          </section>

          {open && !referral && partners.length > 0 && (
            <section className="card stack">
              <h2>Pass to a partner</h2>
              <p className="small muted">Can&apos;t take it? Refer the planner to a partner and earn {vendor.referral_fee_pct}% if they book.</p>
              <form action={referAction} className="row">
                <input type="hidden" name="enquiryId" value={e.id} />
                <select name="partnerId" className="grow" aria-label="Partner">
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.name} · {E.kindLabel(p.kind)}</option>)}
                </select>
                <Submit className="btn btn-ghost btn-sm" pending="Referring…">Refer</Submit>
              </form>
            </section>
          )}

          <section className="card stack">
            <h2>Private note</h2>
            <form action={noteAction} className="stack">
              <input type="hidden" name="enquiryId" value={e.id} />
              <textarea name="body" rows={2} required placeholder="Only your team sees this" />
              <div><button className="btn btn-ghost btn-sm" type="submit">Add note</button></div>
            </form>
          </section>

          <section className="card stack">
            <h2>Delete</h2>
            <p className="small muted">Removes this conversation, its quote and any held date for good. Use it for spam, tests, or when someone asks you to delete their data.</p>
            <form action={deleteEnquiryAction}>
              <input type="hidden" name="enquiryId" value={e.id} />
              <ConfirmSubmit message={`Delete the conversation with ${e.contact_name || e.contact_handle || "this planner"}? This can't be undone.`}>Delete enquiry</ConfirmSubmit>
            </form>
          </section>
        </aside>
      </div>
    </div>
  );
}
