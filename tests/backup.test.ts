import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "matchire-bk-"));
process.env.MATCHIRE_DB = path.join(dir, "matchire.db");
for (const k of ["SMTP_HOST", "RESEND_API_KEY", "BACKUP_PASSWORD"]) delete process.env[k];
const PASSWORD = "correct horse battery staple 7";

const B = await import("../src/lib/backup.ts");
const { run, get } = await import("../src/lib/db.ts");

test("without BACKUP_PASSWORD: the backup stays on the server, isn't emailed, and admins are warned", async () => {
  run("INSERT INTO early_access (name, email) VALUES ('Restore Me', 'r@m.sg')");
  const sent: unknown[] = [];
  const b = await B.createBackup("manual", new Date("2026-10-27T01:00:00Z"), async (m) => { sent.push(m); return null; });
  assert.match(b.file, /^matchire-2026-10-27T01-00-00Z\.db\.gz$/);
  assert.ok(b.bytes > 0);
  assert.equal(sent.length, 0, "never emails an unencrypted database");
  assert.equal(b.emailed_at, null);
  assert.match(b.email_error!, /BACKUP_PASSWORD isn't set/);
  assert.equal(B.backupWarning(), "Backups aren't encrypted: set BACKUP_PASSWORD in Render, then backups are emailed again.");
  assert.deepEqual(B.unencryptedBackups(), [b.file]);

  const restored = path.join(dir, "restored.db");
  writeFileSync(restored, gunzipSync(readFileSync(B.backupFilePath(b.file)!)));
  const copy = new DatabaseSync(restored);
  assert.equal((copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  assert.equal((copy.prepare("SELECT name FROM early_access WHERE email = 'r@m.sg'").get() as { name: string }).name, "Restore Me");
  copy.close();
});

test("only the newest 14 backups are kept", async () => {
  for (let d = 1; d <= 16; d++) await B.createBackup("manual", new Date(Date.UTC(2026, 9, d, 2)), async () => null);
  const files = readdirSync(B.backupDir()).filter((f) => /\.db\.gz(\.enc)?$/.test(f)).sort();
  assert.equal(files.length, 14);
  assert.ok(!files.some((f) => f.startsWith("matchire-2026-10-01T02-00-00Z")), "oldest removed");
  assert.ok(B.listBackups().some((b) => !b.onDisk), "pruned backups show as removed");
});

test("the daily backup runs once per Singapore day, after 3 am", async () => {
  // 2026-11-02 02:30 SGT = 2026-11-01T18:30Z: too early
  assert.equal(await B.maybeDailyBackup(new Date("2026-11-01T18:30:00Z")), null);
  // 03:05 SGT: runs
  const first = await B.maybeDailyBackup(new Date("2026-11-01T19:05:00Z"));
  assert.ok(first);
  assert.equal(first!.sg_date, "2026-11-02");
  // later the same day: doesn't run again
  assert.equal(await B.maybeDailyBackup(new Date("2026-11-02T10:00:00Z")), null);
  assert.equal(get<{ n: number }>("SELECT COUNT(*) n FROM backups WHERE reason = 'daily'")!.n, 1);
});

test("download paths only resolve real backup names", () => {
  assert.equal(B.backupFilePath("../matchire.db"), null);
  assert.equal(B.backupFilePath("matchire-2026-01-01T00-00-00Z.db.gz"), null, "well-formed but missing");
});

// ---------- Encryption ----------

test("encrypt → decrypt gives back the identical bytes; a wrong password fails cleanly", () => {
  const plain = Buffer.from("SQLite format 3\0 pretend database");
  const enc = B.encryptBackup(plain, PASSWORD);
  assert.ok(!enc.includes(plain), "the plain bytes aren't in the file");
  assert.ok(B.decryptBackup(enc, PASSWORD).equals(plain));
  assert.ok(!B.encryptBackup(plain, PASSWORD).equals(enc), "random salt and IV each time");
  assert.throws(() => B.decryptBackup(enc, "wrong password"), (e: Error) => e.message === "Wrong password, or the backup file is damaged." && !e.message.includes(PASSWORD));
  const tampered = Buffer.from(enc); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => B.decryptBackup(tampered, PASSWORD), /Wrong password, or the backup file is damaged/);
  assert.throws(() => B.decryptBackup(Buffer.from("not a backup at all, just some text"), PASSWORD), /isn't an encrypted Matchire backup/);
});

test("with BACKUP_PASSWORD: the file on disk and the emailed attachment are encrypted, and restore to the same database", async () => {
  process.env.BACKUP_PASSWORD = PASSWORD;
  try {
    run("INSERT INTO early_access (name, email) VALUES ('Secret Prices', 'secret@prices.sg')");
    const sent: { to: string; subject: string; text: string; attachments?: { filename: string; content: Buffer; contentType: string }[] }[] = [];
    const logged: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    let b;
    try {
      b = await B.createBackup("manual", new Date("2026-11-01T05:00:00Z"), async (m) => { sent.push(m); return null; });
    } finally {
      Object.assign(console, orig);
    }
    assert.equal(B.backupWarning(), null, "no warning once the password is set");
    assert.match(b.file, /^matchire-2026-11-01T05-00-00Z\.db\.gz\.enc$/);
    assert.ok(b.emailed_at);
    const onDisk = readFileSync(B.backupFilePath(b.file)!);
    assert.ok(!onDisk.includes(Buffer.from("secret@prices.sg")), "nothing readable on disk");

    assert.equal(sent.length, 1);
    const [att] = sent[0].attachments!;
    assert.equal(att.filename, b.file);
    assert.equal(att.contentType, "application/octet-stream");
    assert.ok(att.content.equals(onDisk), "the attachment is the encrypted file");
    assert.ok(!att.content.includes(Buffer.from("secret@prices.sg")));
    for (const text of [sent[0].subject, sent[0].text, ...logged]) assert.ok(!text.includes(PASSWORD), "password never in the email or logs");

    writeFileSync(path.join(dir, "via-lib.db"), gunzipSync(B.decryptBackup(onDisk, PASSWORD)));
    const copy = new DatabaseSync(path.join(dir, "via-lib.db"));
    assert.equal((copy.prepare("SELECT name FROM early_access WHERE email = 'secret@prices.sg'").get() as { name: string }).name, "Secret Prices");
    copy.close();
  } finally {
    delete process.env.BACKUP_PASSWORD;
  }
});

test("scripts/decrypt-backup.mjs restores an encrypted backup, refuses a wrong password, and reads old .db.gz files", async () => {
  process.env.BACKUP_PASSWORD = PASSWORD;
  let b;
  try {
    b = await B.createBackup("manual", new Date("2026-11-01T06:00:00Z"), async () => null);
  } finally {
    delete process.env.BACKUP_PASSWORD;
  }
  const script = path.join(import.meta.dirname, "..", "scripts", "decrypt-backup.mjs");
  const src = B.backupFilePath(b.file)!;
  const env = (pw?: string) => ({ ...process.env, ...(pw ? { BACKUP_PASSWORD: pw } : {}) });

  const wrong = spawnSync(process.execPath, [script, src, path.join(dir, "wrong.db")], { env: env("not it"), encoding: "utf8" });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /Wrong password, or the backup file is damaged/);
  assert.ok(!wrong.stderr.includes("not it") && !wrong.stdout.includes("not it"));
  assert.ok(!existsSync(path.join(dir, "wrong.db")), "nothing written");

  const out = path.join(dir, "script.db");
  const ok = spawnSync(process.execPath, [script, src, out], { env: env(PASSWORD), encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!ok.stdout.includes(PASSWORD));
  const copy = new DatabaseSync(out);
  assert.equal((copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  assert.equal((copy.prepare("SELECT name FROM early_access WHERE email = 'secret@prices.sg'").get() as { name: string }).name, "Secret Prices");
  copy.close();

  const old = B.unencryptedBackups()[0];
  const plainOut = path.join(dir, "old.db");
  const legacy = spawnSync(process.execPath, [script, B.backupFilePath(old)!, plainOut], { env: env(), encoding: "utf8" });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.ok(existsSync(plainOut));
});

test("unencrypted backups can be deleted in one go; encrypted ones stay", () => {
  const before = readdirSync(B.backupDir()).filter((f) => f.endsWith(".enc"));
  assert.ok(B.unencryptedBackups().length > 0);
  assert.equal(B.deleteUnencryptedBackups() > 0, true);
  assert.deepEqual(B.unencryptedBackups(), []);
  assert.deepEqual(readdirSync(B.backupDir()).filter((f) => f.endsWith(".enc")), before);
  assert.ok(B.backupFilePath(before[0]), "encrypted backups still download");
  assert.equal(B.backupFilePath("matchire-2026-11-01T05-00-00Z.db.gz.enc.txt"), null);
});
