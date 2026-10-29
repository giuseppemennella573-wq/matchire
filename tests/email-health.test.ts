import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Admins get a warning on every page when email stops going out.

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-mail-")), "test.db");
delete process.env.SMTP_HOST;
process.env.RESEND_API_KEY = "test";

const { sendRawEmail, emailHealth } = await import("../src/lib/channels.ts");

let status = 200;
globalThis.fetch = (async () => new Response(status === 200 ? "{}" : "invalid key", { status })) as typeof fetch;
const send = () => sendRawEmail({ to: "a@b.sg", subject: "s", text: "t" });

test("email health follows the latest send and remembers when it started failing", async () => {
  assert.equal(emailHealth().ok, true, "no sends yet counts as working");
  assert.equal(await send(), null);
  assert.equal(emailHealth().ok, true);

  status = 401;
  assert.match((await send())!, /401/);
  const first = emailHealth();
  assert.equal(first.ok, false);
  assert.match(first.error!, /401/);
  await new Promise((r) => setTimeout(r, 5));
  await send();
  assert.equal(emailHealth().since, first.since, "a run of failures keeps its start time");

  status = 200;
  assert.equal(await send(), null);
  assert.equal(emailHealth().ok, true, "the warning clears once email works again");
});
