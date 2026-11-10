import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Search engines and AI assistants: canonical, JSON-LD, /llms.txt and robots.txt
// must say exactly what the visible landing page says.
const html = readFileSync("public/landing.html", "utf8");
const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const section = (id: string) => html.match(new RegExp(`<section class="band" id="${id}">[\\s\\S]*?</section>`))![0];
const plans = [...section("pricing").matchAll(/<h3>([^<]+)<\/h3>[\s\S]*?<div class="price">(\d+)<small>/g)].map((m) => ({ name: m[1], price: m[2] }));
const faq = [...section("faq").matchAll(/<summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p>/g)].map((m) => ({ q: text(m[1]), a: text(m[2]) }));
const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
type Node = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const graph = (): Node[] => JSON.parse(blocks[0][1])["@graph"];
const node = (t: string) => graph().find((n) => n["@type"] === t)!;

test("canonical: the landing (served on matchire.ai and app.matchire.ai) points to https://matchire.ai/; privacy has its own", () => {
  assert.deepEqual([...html.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map((m) => m[1]), ["https://matchire.ai/"]);
  assert.match(readFileSync("src/app/privacy/page.tsx", "utf8"), /canonical: "https:\/\/matchire\.ai\/privacy"/);
});

test("one JSON-LD block in <head>; it parses and has the four types", () => {
  assert.equal(blocks.length, 1);
  assert.ok(html.indexOf(blocks[0][0]) < html.indexOf("</head>"));
  assert.deepEqual(graph().map((n) => n["@type"]), ["Organization", "WebSite", "SoftwareApplication", "FAQPage"]);
});

test("JSON-LD copies the page: plan names and SGD prices, hero, meta description, FAQ word for word", () => {
  assert.deepEqual(plans, [{ name: "Solo", price: "79" }, { name: "Studio", price: "199" }, { name: "Venue", price: "449" }]);
  const app = node("SoftwareApplication");
  assert.deepEqual(app.offers.map((o: Node) => ({ name: o.name, price: o.price })), plans);
  for (const o of app.offers) { assert.equal(o.priceCurrency, "SGD"); assert.equal(o.priceSpecification.price, o.price); }
  const note = text(section("pricing").match(/<p class="price-note">([\s\S]*?)<\/p>/)![1]);
  for (const o of app.offers) assert.ok(o.description.endsWith(note), "early-access terms as on the page");
  assert.equal(app.description, text(html.match(/<section class="hero">[\s\S]*?<p class="lede">([\s\S]*?)<\/p>/)![1]));
  for (const chip of ["Photobooths", "Venues", "Caterers", "AV & sound", "Décor & florists", "Emcees"]) assert.ok(app.audience.audienceType.includes(chip));
  assert.equal(node("Organization").description, html.match(/<meta name="description" content="([^"]+)">/)![1]);
  assert.equal(faq.length, 9);
  assert.deepEqual(node("FAQPage").mainEntity.map((q: Node) => ({ q: q.name, a: q.acceptedAnswer.text })), faq);
});

test("/llms.txt: 200, plain text, under 60 lines, prices as on the page, coming-soon stays coming soon", async () => {
  const { GET } = await import("../src/app/llms.txt/route.ts");
  const res = GET();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  const body = await res.text();
  assert.ok(body.startsWith("# Matchire.ai\n\n> "));
  assert.ok(body.trim().split("\n").length < 60);
  for (const p of plans) assert.match(body, new RegExp(`^- ${p.name}: ${p.price}\\. `, "m"));
  assert.match(body, /Instagram DMs: coming soon/);
  assert.ok(body.includes(text(section("pricing").match(/<p class="price-note">([\s\S]*?)<\/p>/)![1])));
  assert.doesNotMatch(body, /payout|trial/i);
});

test("robots.txt allows everyone and names the AI crawlers; footer says who we are", () => {
  const robots = readFileSync("public/robots.txt", "utf8");
  assert.match(robots, /User-agent: \*\nAllow: \//);
  for (const bot of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "ClaudeBot", "Claude-SearchBot", "Google-Extended", "Applebot-Extended"]) {
    assert.match(robots, new RegExp(`User-agent: ${bot}\\nAllow: /`));
  }
  assert.match(robots, /^Sitemap: https:\/\/matchire\.ai\/sitemap\.xml$/m);
  assert.doesNotMatch(robots, /Disallow/);
  assert.match(html, /<footer>[\s\S]*<p class="about">Matchire\.ai is the AI booking desk for event vendors in Singapore, made by MATCHIRE\.AI PTE\. LTD\. \(UEN 202546112G\)\. Not a recruiting or hotel booking service\.<\/p>/);
});
