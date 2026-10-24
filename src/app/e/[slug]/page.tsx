import { notFound } from "next/navigation";
import { get } from "@/lib/db";
import type { Vendor } from "@/lib/types";
import { kindLabel } from "@/lib/engine";
import { submitEnquiryAction } from "./actions";
import { Submit } from "@/components/submit";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const v = get<Vendor>("SELECT * FROM vendors WHERE slug = ?", (await params).slug);
  return { title: v ? `Enquire with ${v.name}` : "Enquiry" };
}

export default async function PublicEnquiry({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ sent?: string; error?: string; embed?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const v = get<Vendor>("SELECT * FROM vendors WHERE slug = ?", slug);
  if (!v) notFound();
  return (
    <main className="public stack-lg" style={sp.embed ? { padding: 16 } : undefined}>
      {!sp.embed && (
        <div className="stack" style={{ gap: 6 }}>
          <p className="eyebrow">{kindLabel(v.kind)} · Singapore</p>
          <h1>Enquire with {v.name}</h1>
          <p className="muted">Tell us about your event and you&apos;ll get a quote within minutes.</p>
        </div>
      )}
      {sp.sent ? (
        <div className="card stack">
          <h2>Thanks, we&apos;ve got it! 🎉</h2>
          <p className="muted">{v.name} will reply to you shortly with availability and a quote.</p>
        </div>
      ) : (
        <form action={submitEnquiryAction} className="card stack">
          <input type="hidden" name="slug" value={v.slug} />
          {sp.embed && <input type="hidden" name="embed" value="1" />}
          <p style={{ position: "absolute", left: -9999 }} aria-hidden="true"><label>Leave empty <input name="website" tabIndex={-1} autoComplete="off" /></label></p>
          {sp.error && <p className="alert alert-err" role="alert">{sp.error}</p>}
          <div className="grid2">
            <label className="field"><span>Your name</span><input name="name" required autoComplete="name" /></label>
            <label className="field"><span>WhatsApp number</span><input name="phone" type="tel" placeholder="+65" autoComplete="tel" /></label>
          </div>
          <label className="field"><span>Email</span><input name="email" type="email" autoComplete="email" /></label>
          <div className="grid3">
            <label className="field"><span>Event date</span><input name="date" type="date" /></label>
            <label className="field"><span>Start time</span><input name="time" type="time" /></label>
            <label className="field"><span>Guests</span><input name="pax" type="number" min="1" /></label>
          </div>
          <label className="field"><span>Tell us about your event</span><textarea name="message" rows={5} required placeholder="What's the occasion, how long do you need us, anything special?" /></label>
          <p className="small muted">We&apos;ll use your details only to reply to this enquiry.</p>
          <div><Submit pending="Sending…">Send enquiry</Submit></div>
        </form>
      )}
      {!sp.embed && <p className="small muted">Powered by <a href="/">Matchire.ai</a></p>}
    </main>
  );
}
