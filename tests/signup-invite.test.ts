import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-inv-")), "test.db");
delete process.env.SIGNUP_INVITE_CODE;

const { validInvite } = await import("../src/lib/invite.ts");
const EA = await import("../src/lib/early-access.ts");

test("no code set: nobody gets the account signup", () => {
  assert.equal(validInvite("anything"), false);
  assert.equal(validInvite(""), false);
  assert.equal(validInvite(undefined), false);
});

test("the one code from SIGNUP_INVITE_CODE opens it; anything else doesn't", () => {
  process.env.SIGNUP_INVITE_CODE = " snap2026 ";
  try {
    assert.equal(validInvite("snap2026"), true);
    assert.equal(validInvite("snap2026 "), true);
    assert.equal(validInvite("Snap2026"), false);
    assert.equal(validInvite("snap"), false);
    assert.equal(validInvite(""), false);
  } finally {
    delete process.env.SIGNUP_INVITE_CODE;
  }
});

test("/signup's waitlist form saves like the landing page's (listed in Admin, alert sent)", () => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ name: "Ana", business: "Snapbox", vendor_type: "Photobooth", enquiries_per_week: "10–30", email: "ana@snap.sg", whatsapp: "9123 4567" })) f.set(k, v);
  const id = EA.signupFromForm(f);
  assert.equal(typeof id, "number");
  assert.equal(EA.listSignups()[0].email, "ana@snap.sg");
  f.set("bot-field", "x");
  assert.equal(EA.signupFromForm(f), "bot");
  const empty = new FormData(); empty.set("name", "Ana");
  assert.equal(EA.signupFromForm(empty), null);

  const actions = readFileSync("src/app/(auth)/actions.ts", "utf8");
  assert.match(actions, /export async function waitlistAction[\s\S]*?notifySignup\(id\)/, "every waitlist submission emails the team");
  assert.match(actions, /export async function signupAction\(form: FormData\) \{[\s\S]{0,200}if \(!validInvite\(invite\)\) redirect\("\/signup"\)/, "the server re-checks the code, not just the page");
  const page = readFileSync("src/app/(auth)/signup/page.tsx", "utf8");
  for (const name of ["name", "business", "vendor_type", "enquiries_per_week", "email", "whatsapp", "bot-field"]) assert.match(page, new RegExp(`name="${name}"`));
});
