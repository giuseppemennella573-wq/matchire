import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { all, db, dbPath, get, nowIso, run } from "./db.ts";
import { sendRawEmail } from "./channels.ts";
import { formatDateTime, sgToday, TZ } from "./dates.ts";

// Database backups. Render already snapshots the disk daily, but those live on
// Render and restore the whole disk at once. These are clean SQLite copies
// (VACUUM INTO never captures a half-written page), kept on the disk for two
// weeks and emailed off-site each day.

const KEEP = 14;
const EMAIL_LIMIT = 20 * 1024 * 1024; // Gmail's attachment limit is 25 MB
const DAILY_HOUR_SGT = 3;
const FILE_RE = /^matchire-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db\.gz$/;

export interface Backup {
  id: number;
  file: string;
  bytes: number;
  reason: "daily" | "manual";
  sg_date: string;
  emailed_at: string | null;
  email_error: string | null;
  created_at: string;
}

export const backupDir = () => path.join(path.dirname(dbPath()), "backups");
export const backupTo = () => process.env.BACKUP_EMAIL || process.env.EARLY_ACCESS_NOTIFY_EMAIL || "giuseppe.mennella@matchire.ai";

/** Absolute path of a backup file, or null if the name isn't one of ours or it's gone. */
export function backupFilePath(file: string): string | null {
  if (!FILE_RE.test(file)) return null;
  const p = path.join(backupDir(), file);
  return existsSync(p) ? p : null;
}

function prune() {
  const files = readdirSync(backupDir()).filter((f) => FILE_RE.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) unlinkSync(path.join(backupDir(), f));
}

export async function createBackup(reason: Backup["reason"], now = new Date()): Promise<Backup> {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, "-") + "Z";
  const raw = path.join(dir, `matchire-${stamp}.db`);
  const file = `matchire-${stamp}.db.gz`;
  if (existsSync(raw)) unlinkSync(raw);
  db().exec(`VACUUM INTO '${raw.replace(/'/g, "''")}'`);
  const gz = gzipSync(readFileSync(raw), { level: 9 });
  writeFileSync(path.join(dir, file), gz);
  unlinkSync(raw);
  prune();

  const id = run("INSERT INTO backups (file, bytes, reason, sg_date, created_at) VALUES (?, ?, ?, ?, ?)", file, gz.length, reason, sgToday(now), now.toISOString());

  let error: string | null;
  if (gz.length > EMAIL_LIMIT) {
    error = `Backup is ${(gz.length / 1048576).toFixed(1)} MB, too large to email. It's kept on the server; download it from the Backups page.`;
  } else {
    try {
      error = await sendRawEmail({
        to: backupTo(),
        subject: `Matchire backup ${sgToday(now)}${reason === "manual" ? " (manual)" : ""}`,
        text: [
          "Attached is a full backup of the Matchire database.",
          "",
          `Taken: ${formatDateTime(now.toISOString())} SGT`,
          `File: ${file} (${(gz.length / 1024).toFixed(0)} KB, gzip-compressed SQLite)`,
          "",
          "Keep this email: it's your off-site copy. It contains customer enquiries, so don't forward it.",
          "To restore, see \"Restoring a backup\" in the README.",
        ].join("\n"),
        attachments: [{ filename: file, content: gz, contentType: "application/gzip" }],
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  if (error) run("UPDATE backups SET email_error = ? WHERE id = ?", error, id);
  else run("UPDATE backups SET emailed_at = ? WHERE id = ?", nowIso(), id);
  return get<Backup>("SELECT * FROM backups WHERE id = ?", id)!;
}

function sgHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(now));
}

/** Called every minute by the scheduler: takes the day's backup once it's past 3 am in Singapore. */
export async function maybeDailyBackup(now = new Date()): Promise<Backup | null> {
  if (sgHour(now) < DAILY_HOUR_SGT) return null;
  if (get("SELECT 1 FROM backups WHERE reason = 'daily' AND sg_date = ?", sgToday(now))) return null;
  return createBackup("daily", now);
}

/** Recent backups that still have a file on disk. */
export function listBackups(): (Backup & { onDisk: boolean })[] {
  return all<Backup>("SELECT * FROM backups ORDER BY id DESC LIMIT 30").map((b) => ({ ...b, onDisk: backupFilePath(b.file) !== null }));
}

export const fileSize = (p: string) => statSync(p).size;
