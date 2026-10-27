import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "matchire-bk-"));
process.env.MATCHIRE_DB = path.join(dir, "matchire.db");
for (const k of ["SMTP_HOST", "RESEND_API_KEY"]) delete process.env[k];

const B = await import("../src/lib/backup.ts");
const { run, get } = await import("../src/lib/db.ts");

test("a backup restores to a working copy of the database", async () => {
  run("INSERT INTO early_access (name, email) VALUES ('Restore Me', 'r@m.sg')");
  const b = await B.createBackup("manual", new Date("2026-10-27T01:00:00Z"));
  assert.match(b.file, /^matchire-2026-10-27T01-00-00Z\.db\.gz$/);
  assert.ok(b.bytes > 0);
  // No email service in tests: the failure is recorded, the backup still exists.
  assert.equal(b.emailed_at, null);
  assert.match(b.email_error!, /isn't configured/);

  const restored = path.join(dir, "restored.db");
  writeFileSync(restored, gunzipSync(readFileSync(B.backupFilePath(b.file)!)));
  const copy = new DatabaseSync(restored);
  assert.equal((copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  assert.equal((copy.prepare("SELECT name FROM early_access WHERE email = 'r@m.sg'").get() as { name: string }).name, "Restore Me");
  copy.close();
});

test("only the newest 14 backups are kept", async () => {
  for (let d = 1; d <= 16; d++) await B.createBackup("manual", new Date(Date.UTC(2026, 9, d, 2)));
  const files = readdirSync(B.backupDir()).filter((f) => f.endsWith(".db.gz")).sort();
  assert.equal(files.length, 14);
  assert.ok(!files.includes("matchire-2026-10-01T02-00-00Z.db.gz"), "oldest removed");
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
