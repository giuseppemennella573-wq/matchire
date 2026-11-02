import Link from "next/link";
import { requireVendor } from "@/lib/auth";
import { all } from "@/lib/db";
import { addDays, dayOfWeek, formatDate, formatDateTime, isValidIsoDate, sgToday } from "@/lib/dates";
import type { Hold } from "@/lib/types";
import { addBookingAction, blockDateAction, releaseHoldAction } from "../actions";
import { availability, dayCap, holdEquipmentNames } from "@/lib/engine";
import { listEquipment } from "@/lib/equipment";

/** "Print booth" → "Print", "360 booth" → "360": short labels for the day cells. */
const short = (name: string) => name.replace(/\s*booths?$/i, "") || name;

export const metadata = { title: "Calendar" };

export default async function Calendar({ searchParams }: { searchParams: Promise<{ month?: string; day?: string; msg?: string; error?: string }> }) {
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
  const equipment = listEquipment(vendor.id);
  const cap = dayCap(vendor, equipment.length > 0);
  // Per-day equipment use, for the days shown (only when the vendor lists equipment).
  const usage = new Map(equipment.length ? days.map((d) => [d, availability(vendor, d)] as const) : []);
  const eqNames = holdEquipmentNames(holds.map((h) => h.id));
  const day = sp.day && isValidIsoDate(sp.day) ? sp.day : null;
  const dayHolds = day ? all<Hold & { contact_name: string | null }>(
    `SELECT h.*, e.contact_name FROM holds h LEFT JOIN enquiries e ON e.id = h.enquiry_id WHERE h.vendor_id = ? AND h.status = 'active' AND h.date = ? ORDER BY h.kind DESC, h.id`,
    vendor.id, day,
  ) : [];
  const dayEq = holdEquipmentNames(dayHolds.map((h) => h.id));
  const dayUse = day ? availability(vendor, day) : null;
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
          {equipment.length ? (
            <p className="muted">
              You own {equipment.map((q, i) => <span key={q.id}>{i ? (i === equipment.length - 1 ? " and " : ", ") : ""}{q.name} × {q.quantity}</span>)}
              {Number.isFinite(cap) ? `, and take at most ${cap} job${cap > 1 ? "s" : ""} a day` : ""}. Matchire checks what&apos;s free before quoting and holds dates for {vendor.hold_hours}h.
            </p>
          ) : (
            <p className="muted">You take {cap} job{cap > 1 ? "s" : ""} a day. Matchire checks this before quoting and holds dates for {vendor.hold_hours}h.</p>
          )}
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
              <Link className="cal-n" href={`/app/calendar?month=${month}&day=${d}`} aria-label={`Details for ${formatDate(d)}`}>{+d.slice(8)}</Link>
              {(() => {
                const u = usage.get(d);
                const busy = u?.equipment.filter((q) => q.used > 0) ?? [];
                if (!u || u.blocked || !busy.length) return null;
                return (
                  <span className="cal-eq">
                    {busy.map((q) => <span key={q.id} className={q.free === 0 ? "full" : ""} title={`${q.name}: ${q.used} of ${q.quantity} out`}>{short(q.name)} {q.used}/{q.quantity}</span>)}
                    {Number.isFinite(u.capacity) && <span className={u.dayFull ? "full" : ""} title="Jobs that day, of your daily most">Jobs {u.used}/{u.capacity}</span>}
                  </span>
                );
              })()}
              {(byDay.get(d) ?? []).map((h) => {
                const eqs = eqNames.get(h.id);
                const text = (h.kind === "block" ? h.note : h.contact_name || h.note || (h.kind === "booking" ? "Booking" : "Hold")) + (eqs ? ` · ${eqs.map(short).join(", ")}` : "");
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

      {day && dayUse && (
        <section className="card stack" id="day">
          <div className="row between">
            <h2>{formatDate(day)}</h2>
            <Link className="small" href={`/app/calendar?month=${month}`}>Close</Link>
          </div>
          {dayUse.blocked ? <p className="small">Blocked: nothing can be booked this day.</p> : equipment.length > 0 && (
            <p className="small">{dayUse.equipment.map((q) => `${q.name}: ${q.free} of ${q.quantity} free`).join(" · ")}{Number.isFinite(dayUse.capacity) ? ` · Jobs: ${dayUse.used} of ${dayUse.capacity}` : ""}</p>
          )}
          {dayHolds.length === 0 ? <p className="empty">Nothing booked or held this day.</p> : (
            <ul className="day-list">
              {dayHolds.map((h) => {
                const eqs = dayEq.get(h.id);
                const who = h.kind === "block" ? h.note : h.contact_name || h.note;
                return (
                  <li key={h.id} className="row between">
                    <span>{h.enquiry_id ? <Link href={`/app/inbox/${h.enquiry_id}`}>{who}</Link> : who}</span>
                    <span className="row small">
                      {equipment.length > 0 && h.kind !== "block" && <span className="muted">{eqs ? eqs.join(", ") : "No equipment set"}</span>}
                      {h.kind === "booking" ? <span className="badge badge-ok">Booked</span> : h.kind === "hold" ? <span className="badge badge-amber">Held until {formatDateTime(h.expires_at)}</span> : <span className="badge">Blocked</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

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
        <div className="stack-lg">
        <section className="card stack">
          <h2>Add a booking</h2>
          <p className="small muted">A job you took outside Matchire, so it isn&apos;t offered to anyone else.</p>
          <form action={addBookingAction} className="stack">
            <div className="grid2">
              <label className="field"><span>Date</span><input type="date" name="date" required min={today} defaultValue={day ?? undefined} /></label>
              <label className="field"><span>Note</span><input name="note" placeholder="Lim wedding, Raffles" /></label>
            </div>
            {equipment.length > 0 && (
              <label className="field"><span>Uses</span>
                <select name="equipment_id" defaultValue="">
                  <option value="">Nothing specific</option>
                  {equipment.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
                </select>
              </label>
            )}
            <div><button className="btn btn-primary btn-sm" type="submit">Add booking</button></div>
          </form>
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
    </div>
  );
}
