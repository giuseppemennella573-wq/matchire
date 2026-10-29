import Link from "next/link";
import { resetPasswordAction } from "../../actions";
import { resetTokenUser, MIN_PASSWORD } from "@/lib/password-reset";
import { Logo } from "@/components/logo";

export const metadata = { title: "Choose a new password" };
export const dynamic = "force-dynamic";

export default async function ResetPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await params;
  const { error } = await searchParams;
  const user = resetTokenUser(decodeURIComponent(token));
  return (
    <main className="auth">
      <div className="card stack-lg">
        <Logo href="/" style={{ padding: "8px 0 0" }} />
        {user ? (
          <>
            <div className="stack">
              <h1>Choose a new password</h1>
              <p className="muted">For {user.email}. You&apos;ll be logged out everywhere else.</p>
            </div>
            {error && <p className="alert alert-err" role="alert">{error}</p>}
            <form action={resetPasswordAction} className="stack">
              <input type="hidden" name="token" value={decodeURIComponent(token)} />
              <label className="field"><span>New password</span><input name="password" type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" /></label>
              <label className="field"><span>Type it again</span><input name="confirm" type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" /></label>
              <button className="btn btn-primary" type="submit">Save new password</button>
            </form>
          </>
        ) : (
          <div className="stack">
            <h1>This link has expired</h1>
            <p className="muted">Reset links work once and expire after 1 hour.</p>
            <p><Link className="btn btn-primary" href="/forgot">Send a new link</Link></p>
          </div>
        )}
      </div>
    </main>
  );
}
