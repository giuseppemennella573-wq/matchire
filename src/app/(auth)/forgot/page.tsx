import Link from "next/link";
import { forgotPasswordAction } from "../actions";
import { Logo } from "@/components/logo";

export const metadata = { title: "Reset your password" };

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const { sent } = await searchParams;
  return (
    <main className="auth">
      <div className="card stack-lg">
        <Logo href="/" style={{ padding: "8px 0 0" }} />
        <div className="stack">
          <h1>Reset your password</h1>
          <p className="muted">Enter the email you log in with. We&apos;ll send you a link to choose a new password.</p>
        </div>
        {sent ? (
          <p className="alert alert-ok" role="status">If an account exists for that email, we&apos;ve sent a reset link. It works once and expires in 1 hour. Check your spam folder if it doesn&apos;t arrive.</p>
        ) : (
          <form action={forgotPasswordAction} className="stack">
            <label className="field"><span>Email</span><input name="email" type="email" required autoComplete="email" /></label>
            <button className="btn btn-primary" type="submit">Send reset link</button>
          </form>
        )}
        <p className="small muted"><Link href="/login">Back to log in</Link></p>
      </div>
    </main>
  );
}
