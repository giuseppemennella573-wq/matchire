import Link from "next/link";
import { requireVendor } from "@/lib/auth";
import { all } from "@/lib/db";
import { addDays, dayOfWeek, formatDate, formatDateTime, sgToday } from "@/lib/dates";
import type { Hold } from "@/lib/types";
import { blockDateAction, releaseHoldAction } from "../actions";

export const metadata = { title: "Calendar" };

export default async function Calendar({ searchParams }: { searchParams: Promise<{ month?: string; msg?: string; error?: string }> }) {
  const { vendor } = await requireVendor();
  const sp = await searchParams;
  const today = sgToday();
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : today.slice(0, 7);
  const first = `${month}-01`;
  const start = addDays(first, -((dayOfWeek(first) + 6) % 7)); // Monday on or before the 1st
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const end = days[days.length - 1];
  const prev = addDays(first, -1).slice(0, 7);
  const next = addDays(first, 32).slice(0, 7);
  const label = new Date(first + "T00:00:00Z").toLocaleDateString("en-SG", { month: "long", year: "numeric", timeZone: "UTC" });

  const holds = all<Hold & { contact_name: string | null }>(
    `SELECT h.*, e.contact_name FROM holds h LEFT JOIN enquiries e ON e.id = h.enquiry_id
     WHERE h.vendor_id = ? AND h.status = 'active' AND h.date BETWEEN ? AND ? ORDER BY h.kind DESC, h.id`,
    vendor.id, start, end,
  );
  const byDay = new Map<string, typeof holds>();
  holds.forEach((h) => byDay.set(h.date, [...(byDay.get(h.date) ?? []), h]));
  const upcoming = all<Hold & { contact_name: string | null }>(
    `SELECT h.*, e.contact_name FROM holds h LEFT JOIN enquiries e ON e.id = h.enquiry_id
     WHERE h.vendor_id = ? AND h.status = 'active' AND h.date >= ? ORDER BY h.date LIMIT 30`,
    vendor.id, today,
  );

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <h1>Calendar</h1>
          <p className="muted">You take {vendor.jobs_per_day} job{vendor.jobs_per_day > 1 ? "s" : ""} a day. Matchire checks this before quoting and holds dates for {vendor.hold_hours}h.</p>
        </div>
        <div className="row">
          <Link className="btn btn-ghost btn-sm" href={`/app/calendar?month=${prev}`} aria-label="Previous month">←</Link>
          <b style={{ minWidth: 140, textAlign: "center" }}>{label}</b>
          <Link className="btn btn-ghost btn-sm" href={`/app/calendar?month=${next}`} aria-label="Next month">→</Link>
        </div>
      </div>
      {sp.msg && <p className="alert alert-ok" role="status">{sp.msg}</p>}
      {sp.error && <p className="alert alert-err" role="alert">{sp.error}</p>}

      <section className="card">
        <div className="cal" role="grid" aria-label={label}>
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="cal-h">{d}</div>)}
          {days.map((d) => (
            <div key={d} className={`cal-d${d < today ? " past" : ""}${d === today ? " today" : ""}`} style={d.slice(0, 7) !== month ? { opacity: 0.4 } : undefined}>
              <span className="cal-n">{+d.slice(8)}</span>
              {(byDay.get(d) ?? []).map((h) => {
                const text = h.kind === "block" ? h.note : h.contact_name || h.note || (h.kind === "booking" ? "Booking" : "Hold");
                return h.enquiry_id
                  ? <Link key={h.id} href={`/app/inbox/${h.enquiry_id}`} className={`ev ev-${h.kind}`} title={text}>{text}</Link>
                  : <span key={h.id} className={`ev ev-${h.kind}`} title={text}>{text}</span>;
              })}
            </div>
          ))}
        </div>
        <div className="row small muted" style={{ marginTop: 12 }}>
          <span className="ev ev-booking">Booked</span><span className="ev ev-hold">On hold</span><span className="ev ev-block">Blocked</span>
        </div>
      </section>

      <div className="two-col">
        <section className="card card-flush">
          <div className="card-head"><h2>Upcoming</h2></div>
          {upcoming.length === 0 ? <p className="empty">Nothing on the calendar yet.</p> : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {upcoming.map((h) => (
                    <tr key={h.id}>
                      <td className="mono small">{formatDate(h.date)}</td>
                      <td>{h.enquiry_id ? <Link href={`/app/inbox/${h.enquiry_id}`}>{h.contact_name || h.note}</Link> : h.note}</td>
                      <td>{h.kind === "booking" ? <span className="badge badge-ok">Booked</span> : h.kind === "hold" ? <span className="badge badge-amber">Until {formatDateTime(h.expires_at)}</span> : <span className="badge">Blocked</span>}</td>
                      <td>
                        {h.kind !== "booking" && (
                          <form action={releaseHoldAction}><input type="hidden" name="holdId" value={h.id} /><button className="btn btn-ghost btn-sm" type="submit">Release</button></form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card stack">
          <h2>Block a date</h2>
          <p className="small muted">Days you&apos;re away or booked elsewhere. Matchire won&apos;t offer them.</p>
          <form action={blockDateAction} className="stack">
            <label className="field"><span>Date</span><input type="date" name="date" required min={today} /></label>
            <label className="field"><span>Note</span><input name="note" placeholder="Booked outside Matchire" /></label>
            <div><button className="btn btn-primary btn-sm" type="submit">Block date</button></div>
          </form>
        </section>
      </div>
    </div>
  );
}
