// Compares models on "reading an enquiry" (aiExtract): accuracy on a labelled
// set and cost per enquiry, with prompt caching on and off. Real API calls:
// costs a few cents per model. Needs ANTHROPIC_API_KEY.
//
//   node --experimental-strip-types scripts/eval-extract.ts
//   node --experimental-strip-types scripts/eval-extract.ts --models claude-opus-5-5,claude-haiku-5-5
//
// Writes nothing to the real database (it uses a temporary one).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-eval-")), "eval.db");
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error("Set ANTHROPIC_API_KEY first.");
  process.exit(1);
}

const { aiExtract, setClientForTests } = await import("../src/lib/ai.ts");
// --dry: no API calls, a fake answer, to check the script itself works.
if (process.argv.includes("--dry")) setClientForTests({ beta: { messages: { parse: async (req: { model: string }) => ({ model: req.model, stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  parsed_output: { contact_name: null, event_date: null, date_text: null, date_is_approximate: false, slot: null, start_time: null, hours: null, pax: null, budget: null, event_type: null, location: null, style: null, package_id: null, addon_ids: [], needs: [], questions: [], needs_owner: false, owner_reason: null, intent: "new_enquiry", summary: null } }) } } });
const { costUsd } = await import("../src/lib/ai-usage.ts");
const { all, run } = await import("../src/lib/db.ts");
const { createAccount, addItems } = await import("../src/lib/accounts.ts");
const { getVendor, getItems } = await import("../src/lib/engine.ts");
const { CASES, TODAY } = await import("./eval-extract-cases.ts");

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const models = (arg("--models") ?? `${process.env.MATCHIRE_MODEL || "claude-opus-5-5"},claude-sonnet-5-5,claude-haiku-5-5`).split(",");

// The demo's photobooth price list and notes, so prompts look like production.
const vendorId = createAccount({ email: "eval@matchire.ai", password: "eval-password", name: "Mel", business: "Snap & Smile Photobooth", kind: "photobooth" }).vendorId;
run("UPDATE vendors SET notes = ? WHERE id = ?", "We need a 2m x 3m space and one power socket. Setup takes 45 minutes. 30% deposit secures the date. Travel to Sentosa or Jurong Island: +S$80.", vendorId);
const P = (name: string, price: number, hours: number) => ({ kind: "package" as const, name, pricing: "flat" as const, price, included_hours: hours, extra_hour_price: 180, description: "Unlimited prints, props and an attendant", min_pax: null, max_pax: null });
const AO = (name: string, price: number) => ({ kind: "addon" as const, name, pricing: "flat" as const, price, included_hours: null, extra_hour_price: null, description: "", min_pax: null, max_pax: null });
addItems(vendorId, [P("Classic Booth 2h", 650, 2), P("Classic Booth 3h", 850, 3), P("Classic Booth 4h", 1050, 4), { ...P("360 Video Booth 3h", 1200, 3), extra_hour_price: 350 }, AO("Custom backdrop", 120), AO("Guestbook album", 150), AO("Digital gallery + GIFs", 90)]);
const vendor = getVendor(vendorId)!;
const items = getItems(vendorId);
const pkgName = (id: number | null) => items.find((i) => i.id === id)?.name ?? null;

type Field = keyof (typeof CASES)[number]["expect"];
const FIELDS: Field[] = ["event_date", "pax", "hours", "budget", "location", "package", "intent"];

function score(expect: (typeof CASES)[number]["expect"], got: Awaited<ReturnType<typeof aiExtract>>) {
  const res: Partial<Record<Field, boolean>> = {};
  for (const f of FIELDS) {
    if (!(f in expect)) continue;
    const want = expect[f];
    const have = f === "package" ? pkgName(got.package_id) : f === "location" ? got.location : got[f as "event_date" | "pax" | "hours" | "budget" | "intent"];
    res[f] = f === "location" && typeof want === "string" ? !!have && String(have).toLowerCase().includes(want.toLowerCase()) : have === want;
  }
  return res;
}

const rows: { model: string; cache: string; correct: number; checks: number; perEnquiry: number; cacheRead: number; cacheWrite: number; failures: string[] }[] = [];
for (const model of models) {
  for (const cache of ["on", "off"]) {
    process.env.MATCHIRE_PROMPT_CACHE = cache;
    run("DELETE FROM ai_usage");
    let correct = 0, checks = 0;
    const failures: string[] = [];
    for (const c of CASES) {
      try {
        const got = await aiExtract({ vendor, items, messages: c.messages.map((body, i) => ({ direction: i % 2 ? "out" as const : "in" as const, body, created_at: `${TODAY}T0${i}:00:00Z` })), previous: null, today: TODAY, model });
        for (const [f, okay] of Object.entries(score(c.expect, got))) { checks++; if (okay) correct++; else failures.push(`${c.name}: ${f}`); }
      } catch (e) {
        checks += Object.keys(c.expect).length;
        failures.push(`${c.name}: call failed (${e instanceof Error ? e.message : e})`);
      }
    }
    const u = all<{ model: string; input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number }>("SELECT model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens FROM ai_usage");
    const cost = u.reduce((s, r) => s + (costUsd(r.model, { input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_creation_input_tokens: r.cache_write_tokens, cache_read_input_tokens: r.cache_read_tokens }) ?? 0), 0);
    rows.push({ model, cache, correct, checks, perEnquiry: cost / CASES.length, cacheRead: u.reduce((s, r) => s + r.cache_read_tokens, 0), cacheWrite: u.reduce((s, r) => s + r.cache_write_tokens, 0), failures });
    console.log(`${model} (cache ${cache}): ${correct}/${checks} correct, $${(cost / CASES.length).toFixed(5)} per enquiry`);
  }
}

console.log("\n| Model | Cache | Accuracy | Cost per enquiry (USD) | Cache read / write tokens |\n|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.model} | ${r.cache} | ${r.correct}/${r.checks} (${Math.round((100 * r.correct) / r.checks)}%) | $${r.perEnquiry.toFixed(5)} | ${r.cacheRead} / ${r.cacheWrite} |`);
console.log("\nMisses:");
for (const r of rows.filter((r) => r.cache === "on")) console.log(`- ${r.model}: ${r.failures.length ? r.failures.join("; ") : "none"}`);
