import Link from "next/link";
import { loginAction } from "../actions";
import { Logo } from "@/components/logo";

export const metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; msg?: string }> }) {
  const { error, msg } = await searchParams;
  return (
    <main className="auth">
      <div className="card stack-lg">
        <Logo href="/" style={{ padding: "8px 0 0" }} />
        <div className="stack">
          <h1>Welcome back</h1>
          <p className="muted">Your enquiries, quotes and holds are waiting.</p>
        </div>
        {msg && <p className="alert alert-ok" role="status">{msg}</p>}
        {error && <p className="alert alert-err" role="alert">{error}</p>}
        <form action={loginAction} className="stack">
          <label className="field"><span>Email</span><input name="email" type="email" required autoComplete="email" /></label>
          <label className="field"><span>Password</span><input name="password" type="password" required autoComplete="current-password" /></label>
          <Link href="/forgot" className="small">Forgot your password?</Link>
          <button className="btn btn-primary" type="submit">Log in</button>
        </form>
        <p className="small muted">New to Matchire? <Link href="/signup">Create an account</Link></p>
      </div>
    </main>
  );
}
