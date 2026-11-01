import { readFileSync } from "node:fs";
import { currentAdmin } from "@/lib/auth";
import { backupFilePath, isEncrypted } from "@/lib/backup";

// Download one backup file, as it is on disk (encrypted, for any backup taken with
// BACKUP_PASSWORD set). Admins only; the name must match a backup we made.
export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  if (!(await currentAdmin())) return new Response("Not found", { status: 404 });
  const { file } = await ctx.params;
  const p = backupFilePath(file);
  if (!p) return new Response("Not found", { status: 404 });
  return new Response(readFileSync(p), {
    headers: { "Content-Type": isEncrypted(file) ? "application/octet-stream" : "application/gzip", "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "no-store" },
  });
}
