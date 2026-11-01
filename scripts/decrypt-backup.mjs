// Turn a Matchire backup back into a SQLite database file.
//
//   node scripts/decrypt-backup.mjs matchire-2026-11-01T19-00-00Z.db.gz.enc [restore.db]
//
// Encrypted backups (.db.gz.enc) need the backup password: it's read from
// BACKUP_PASSWORD if that's set, otherwise you're asked for it (nothing is shown
// as you type). Old unencrypted backups (.db.gz) need no password.
// Plain Node with no dependencies, so it runs on Render's Shell and on a laptop.
// The file layout matches src/lib/backup.ts.
import { createDecipheriv, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import readline from "node:readline";

const MAGIC = Buffer.from("MATCHIRE-BACKUP-1\n");
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function askPassword() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write("Backup password: ");
    rl._writeToOutput = () => {}; // don't echo what's typed
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

const [input, outArg] = process.argv.slice(2);
if (!input) fail("Usage: node scripts/decrypt-backup.mjs <backup file> [output.db]");
if (!existsSync(input)) fail(`No such file: ${input}`);
const out = outArg || input.replace(/\.db\.gz(\.enc)?$/, "") + ".db";
if (out === input) fail("Give an output file name ending in .db");
if (existsSync(out)) fail(`${out} already exists. Move it away or give another output name.`);

const data = readFileSync(input);
let gz;
if (data.subarray(0, MAGIC.length).equals(MAGIC)) {
  const password = process.env.BACKUP_PASSWORD || (await askPassword());
  if (!password) fail("No password given.");
  let o = MAGIC.length;
  const salt = data.subarray(o, (o += 16)), iv = data.subarray(o, (o += 12)), tag = data.subarray(o, (o += 16));
  try {
    const d = createDecipheriv("aes-256-gcm", scryptSync(password, salt, 32, SCRYPT), iv);
    d.setAAD(Buffer.concat([MAGIC, salt, iv]));
    d.setAuthTag(tag);
    gz = Buffer.concat([d.update(data.subarray(o)), d.final()]);
  } catch {
    fail("Wrong password, or the backup file is damaged. Nothing was written.");
  }
} else if (data[0] === 0x1f && data[1] === 0x8b) {
  gz = data; // an old, unencrypted .db.gz
} else {
  fail("This isn't a Matchire backup (.db.gz.enc or .db.gz).");
}

writeFileSync(out, gunzipSync(gz));
console.log(`Wrote ${out}`);
