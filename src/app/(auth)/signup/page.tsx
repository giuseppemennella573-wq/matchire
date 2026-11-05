import Link from "next/link";
import { signupAction, waitlistAction } from "../actions";
import { VENDOR_KINDS } from "@/lib/types";
import { Logo } from "@/components/logo";
import { validInvite } from "@/lib/invite";

export const metadata = { title: "Create your account" };

// Same choices as the landing page's early-access form.
const VENDOR_TYPES = ["Photobooth", "Venue", "Catering", "AV & sound", "Décor / florist", "Emcee / entertainment", "Photography / video", "Other"];
const VOLUMES = ["Under 10", "10–30", "30–80", "80+"];

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string; invite?: string; sent?: string }> }) {
  const { error, invite, sent } = await searchParams;
  if (!validInvite(invite)) return <Waitlist error={error} sent={!!sent} />;
  return (
    <main className="auth">
      <div className="card stack-lg">
        <Logo href="/" style={{ padding: "8px 0 0" }} />
        <div className="stack">
          <h1>Set up your booking desk</h1>
          <p className="muted">Takes two minutes. You can connect WhatsApp and email afterwards.</p>
        </div>
        {error && <p className="alert alert-err" role="alert">{error}</p>}
        <form action={signupAction} className="stack">
          <input type="hidden" name="invite" value={invite} />
          <div className="grid2">
            <label className="field"><span>Your name</span><input name="name" required autoComplete="name" /></label>
            <label className="field"><span>Business name</span><input name="business" required autoComplete="organization" /></label>
          </div>
          <label className="field">
            <span>What do you do?</span>
            <select name="kind" required defaultValue="">
              <option value="" disabled>Choose one</option>
              {VENDOR_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </label>
          <label className="field"><span>Email</span><input name="email" type="email" required autoComplete="email" /></label>
          <label className="field"><span>Password</span><input name="password" type="password" required minLength={8} autoComplete="new-password" /></label>
          <label className="check small">
            <input type="checkbox" name="sample" defaultChecked />
            <span>Start with a sample price list for my category (you&apos;ll edit it before going live)</span>
          </label>
          <button className="btn btn-primary" type="submit">Create account</button>
        </form>
        <p className="small muted">Already have an account? <Link href="/login">Log in</Link></p>
      </div>
    </main>
  );
}

/** No valid invite: the early-access form, with the landing page's wording. */
function Waitlist({ error, sent }: { error?: string; sent: boolean }) {
  return (
    <main className="auth">
      <div className="card stack-lg">
        <Logo href="/" style={{ padding: "8px 0 0" }} />
        <div className="stack">
          <h1>Be one of our first 50 vendors in Singapore</h1>
          <p className="muted">We&apos;re onboarding a small group of event vendors by hand. Tell us about your business and we&apos;ll be in touch on WhatsApp within two working days.</p>
        </div>
        {sent ? (
          <p className="alert alert-ok" role="status">Thanks! We&apos;ll be in touch on WhatsApp within two working days.</p>
        ) : (
          <>
            {error && <p className="alert alert-err" role="alert">{error}</p>}
            <form action={waitlistAction} className="stack">
              <p hidden><label>Leave this empty <input name="bot-field" tabIndex={-1} autoComplete="off" /></label></p>
              <div className="grid2">
                <label className="field"><span>Your name</span><input name="name" required autoComplete="name" /></label>
                <label className="field"><span>Business name</span><input name="business" required autoComplete="organization" /></label>
              </div>
              <div className="grid2">
                <label className="field">
                  <span>What do you do?</span>
                  <select name="vendor_type" required defaultValue="">
                    <option value="" disabled>Choose one</option>
                    {VENDOR_TYPES.map((t) => <option key={t}>{t}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Enquiries per week</span>
                  <select name="enquiries_per_week" defaultValue="10–30">
                    {VOLUMES.map((t) => <option key={t}>{t}</option>)}
                  </select>
                </label>
              </div>
              <label className="field"><span>Email</span><input name="email" type="email" required autoComplete="email" /></label>
              <label className="field"><span>WhatsApp number</span><input name="whatsapp" type="tel" placeholder="+65" autoComplete="tel" /></label>
              <p className="small muted">We&apos;ll only use your details to contact you about Matchire early access.</p>
              <button className="btn btn-primary" type="submit">Request early access</button>
            </form>
          </>
        )}
        <p className="small muted">Already have an account? <Link href="/login">Log in</Link></p>
      </div>
    </main>
  );
}
