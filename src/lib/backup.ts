import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import { all, db, dbPath, get, nowIso, run } from "./db.ts";
import { sendRawEmail } from "./channels.ts";
import { formatDateTime, sgToday, TZ } from "./dates.ts";

// Database backups. Render already snapshots the disk daily, but those live on
// Render and restore the whole disk at once. These are clean SQLite copies
// (VACUUM INTO never captures a half-written page), kept on the disk for two
// weeks and emailed off-site each day. With BACKUP_PASSWORD set, every copy is
// encrypted before it touches the disk or the mailbox; without it, backups stay
// on the server and aren't emailed (scripts/decrypt-backup.mjs restores them).

const KEEP = 14;
const EMAIL_LIMIT = 20 * 1024 * 1024; // Gmail's attachment limit is 25 MB
const DAILY_HOUR_SGT = 3;
const FILE_RE = /^matchire-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db\.gz(\.enc)?$/;

// ---------- Encryption ----------
// File layout: MAGIC | salt (16) | IV (12) | GCM tag (16) | ciphertext of the .db.gz.
// The key is scrypt(BACKUP_PASSWORD, salt). scripts/decrypt-backup.mjs reads the same layout.
const MAGIC = Buffer.from("MATCHIRE-BACKUP-1\n");
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const WRONG_PASSWORD = "Wrong password, or the backup file is damaged.";

export const backupPassword = () => process.env.BACKUP_PASSWORD || null;
export const isEncrypted = (file: string) => file.endsWith(".enc");

/** The admin warning while backups can't be encrypted, or null. */
export const backupWarning = () =>
  backupPassword() ? null : "Backups aren't encrypted: set BACKUP_PASSWORD in Render, then backups are emailed again.";

export function encryptBackup(plain: Buffer, password: string): Buffer {
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", scryptSync(password, salt, 32, SCRYPT), iv);
  c.setAAD(Buffer.concat([MAGIC, salt, iv]));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

export function decryptBackup(data: Buffer, password: string): Buffer {
  if (data.length < MAGIC.length + 44 || !data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("This isn't an encrypted Matchire backup.");
  let o = MAGIC.length;
  const salt = data.subarray(o, (o += 16)), iv = data.subarray(o, (o += 12)), tag = data.subarray(o, (o += 16));
  try {
    const d = createDecipheriv("aes-256-gcm", scryptSync(password, salt, 32, SCRYPT), iv);
    d.setAAD(Buffer.concat([MAGIC, salt, iv]));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data.subarray(o)), d.final()]);
  } catch {
    throw new Error(WRONG_PASSWORD);
  }
}

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

type Send = typeof sendRawEmail;

export async function createBackup(reason: Backup["reason"], now = new Date(), send: Send = sendRawEmail): Promise<Backup> {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const password = backupPassword();
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, "-") + "Z";
  const raw = path.join(dir, `matchire-${stamp}.db`);
  const file = `matchire-${stamp}.db.gz${password ? ".enc" : ""}`;
  if (existsSync(raw)) unlinkSync(raw);
  db().exec(`VACUUM INTO '${raw.replace(/'/g, "''")}'`);
  let data: Buffer;
  try {
    const gz = gzipSync(readFileSync(raw), { level: 9 });
    data = password ? encryptBackup(gz, password) : gz;
  } finally {
    unlinkSync(raw);
  }
  writeFileSync(path.join(dir, file), data);
  prune();

  const id = run("INSERT INTO backups (file, bytes, reason, sg_date, created_at) VALUES (?, ?, ?, ?, ?)", file, data.length, reason, sgToday(now), now.toISOString());

  let error: string | null;
  if (!password) {
    error = "Not emailed: BACKUP_PASSWORD isn't set, so this unencrypted backup stays on the server only.";
  } else if (data.length > EMAIL_LIMIT) {
    error = `Backup is ${(data.length / 1048576).toFixed(1)} MB, too large to email. It's kept on the server; download it from the Backups page.`;
  } else {
    try {
      error = await send({
        to: backupTo(),
        subject: `Matchire backup ${sgToday(now)}${reason === "manual" ? " (manual)" : ""}`,
        text: [
          "Attached is a full, encrypted backup of the Matchire database.",
          "",
          `Taken: ${formatDateTime(now.toISOString())} SGT`,
          `File: ${file} (${(data.length / 1024).toFixed(0)} KB, AES-256 encrypted with your backup password)`,
          "",
          "Keep this email: it's your off-site copy. Without the backup password it can't be opened.",
          "To restore: node scripts/decrypt-backup.mjs <file>, then follow \"Restoring a backup\" in the README.",
        ].join("\n"),
        attachments: [{ filename: file, content: data, contentType: "application/octet-stream" }],
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  if (error) run("UPDATE backups SET email_error = ? WHERE id = ?", error, id);
  else run("UPDATE backups SET emailed_at = ? WHERE id = ?", nowIso(), id);
  return get<Backup>("SELECT * FROM backups WHERE id = ?", id)!;
}

/** Backups from before encryption (or taken without a password) that are still on disk. */
export function unencryptedBackups(): string[] {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => FILE_RE.test(f) && !isEncrypted(f)).sort().reverse();
}

export function deleteUnencryptedBackups(): number {
  const files = unencryptedBackups();
  for (const f of files) unlinkSync(path.join(backupDir(), f));
  return files.length;
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
