// Emergency password reset, for when email isn't working.
// On the server (Render → Shell):   node scripts/set-password.mjs you@example.com
// It asks for the new password, then logs that account out everywhere.
// Plain JavaScript on purpose: the production image has no TypeScript sources.
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline/promises";
import path from "node:path";

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) {
  console.error("Usage: node scripts/set-password.mjs <email>");
  process.exit(1);
}
const file = process.env.MATCHIRE_DB || path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "matchire.db");
const db = new DatabaseSync(file);
const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
if (!user) {
  console.error(`No account with the email ${email} in ${file}.`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = process.argv[3] ?? (await rl.question("New password (at least 8 characters): "));
rl.close();
if (password.length < 8) {
  console.error("Use a password of at least 8 characters.");
  process.exit(1);
}

// Same format as src/lib/accounts.ts hashPassword().
const salt = randomBytes(16);
const hash = `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64).toString("hex")}`;
db.exec("BEGIN");
db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
db.exec("COMMIT");
console.log(`Password updated for ${email}. They've been logged out everywhere.`);
