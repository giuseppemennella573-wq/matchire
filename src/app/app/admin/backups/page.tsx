import { requireAdmin } from "@/lib/auth";
import { backupTo, listBackups } from "@/lib/backup";
import { emailReady } from "@/lib/channels";
import { formatDateTime } from "@/lib/dates";
import { backupNowAction } from "../actions";
import { Submit } from "@/components/submit";

export const metadata = { title: "Backups" };

const size = (b: number) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);

export default async function Backups({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string }> }) {
  await requireAdmin();
  const { msg, error } = await searchParams;
  const rows = listBackups();
  const last = rows[0];

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <p className="eyebrow">Matchire admin</p>
          <h1>Backups</h1>
          <p className="muted">A full copy of the database is taken every day at 3 am Singapore time, kept here for 14 days, and emailed to <b>{backupTo()}</b> as an off-site copy.</p>
        </div>
        <form action={backupNowAction}><Submit pending="Backing up…">Back up now</Submit></form>
      </div>
      {msg && <p className="alert alert-ok" role="status">{msg}</p>}
      {error && <p className="alert alert-err" role="alert">{error}</p>}
      {!emailReady() && <p className="alert alert-warn">Email isn&apos;t set up, so backups are only kept on the server. Set the SMTP settings in Render to get the daily off-site copy.</p>}
      {emailReady() && last && last.email_error && <p className="alert alert-warn">The latest backup wasn&apos;t emailed: {last.email_error}</p>}

      <section className="card card-flush">
        {rows.length === 0 ? <p className="empty">No backups yet. The first one runs tonight at 3 am, or click Back up now.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Taken</th><th>Type</th><th>Size</th><th>Emailed</th><th /></tr></thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}>
                    <td>{formatDateTime(b.created_at)}</td>
                    <td className="small">{b.reason === "daily" ? "Daily" : "Manual"}</td>
                    <td className="mono small">{size(b.bytes)}</td>
                    <td>{b.emailed_at ? <span className="badge badge-ok">Emailed</span> : <span className="badge badge-red" title={b.email_error ?? ""}>Not emailed</span>}</td>
                    <td>{b.onDisk ? <a className="btn btn-ghost btn-sm" href={`/app/admin/backups/${b.file}`}>Download</a> : <span className="small muted">Removed after 14 days</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card stack small">
        <h3>Restoring</h3>
        <p className="muted">Restoring replaces everything with the backup&apos;s contents, so changes made since then are lost. Ask Claude to walk you through it, or follow &quot;Restoring a backup&quot; in the README. Render also keeps its own daily snapshot of the whole disk for at least 7 days as a last resort.</p>
      </section>
    </div>
  );
}
