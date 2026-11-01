import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getVendor } from "@/lib/engine";
import { SUPPORT_MINUTES, vendorOwner } from "@/lib/support";
import { startSupportAction } from "../../actions";
import { Submit } from "@/components/submit";

export const metadata = { title: "Support view" };

export default async function StartSupport({ params, searchParams }: { params: Promise<{ vendorId: string }>; searchParams: Promise<{ error?: string }> }) {
  const { user } = await requireAdmin();
  const { vendorId } = await params;
  const { error } = await searchParams;
  const v = getVendor(Number(vendorId));
  if (!v) notFound();
  const owner = vendorOwner(v.id);
  const own = v.id === user.vendor_id;

  return (
    <div className="stack-lg" style={{ maxWidth: 640 }}>
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <p className="eyebrow">Matchire admin</p>
          <h1>Support view: {v.name}</h1>
          <p className="muted"><Link href="/app/admin/accounts">← Accounts</Link></p>
        </div>
      </div>
      {error && <p className="alert alert-err" role="alert">{error}</p>}
      {own ? <p className="alert alert-warn">This is your own account.</p> : (
        <form action={startSupportAction} className="card stack">
          <input type="hidden" name="vendorId" value={v.id} />
          <p className="small">
            You&apos;ll see {v.name}&apos;s desk exactly as they do, <b>read-only</b>, for {SUPPORT_MINUTES} minutes. You can&apos;t send, save,
            delete or change settings. The session, your reason and every page you open are logged, and {v.name} sees them in
            Settings → Account{owner ? <> and gets an email at <b>{owner.email}</b></> : null}.
          </p>
          <label className="field">
            <span>Why are you opening this account?</span>
            <textarea name="reason" required minLength={5} maxLength={300} rows={3} placeholder="Helping set up WhatsApp, vendor asked by email" />
          </label>
          <div className="row"><Submit pending="Opening…">Open support view</Submit></div>
        </form>
      )}
    </div>
  );
}
