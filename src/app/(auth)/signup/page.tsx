import Link from "next/link";
import { signupAction } from "../actions";
import { VENDOR_KINDS } from "@/lib/types";

export const metadata = { title: "Create your account" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="auth">
      <div className="card stack-lg">
        <a className="logo" href="/" style={{ padding: 0 }}><span className="logo-mark" aria-hidden="true" />Matchire<span>.ai</span></a>
        <div className="stack">
          <h1>Set up your booking desk</h1>
          <p className="muted">Takes two minutes. You can connect WhatsApp and email afterwards.</p>
        </div>
        {error && <p className="alert alert-err" role="alert">{error}</p>}
        <form action={signupAction} className="stack">
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
