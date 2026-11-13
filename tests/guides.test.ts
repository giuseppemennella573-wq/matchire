import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// The guides: static pages in public/guides, served at /guides and /guides/<slug> on both hosts.
const SLUGS = ["reply-to-event-enquiries-singapore", "whatsapp-enquiry-templates-event-vendors", "ai-booking-assistant-for-event-vendors"];
const PAGES = [{ url: "/guides", file: "public/guides/index.html" }, ...SLUGS.map((s) => ({ url: `/guides/${s}`, file: `public/guides/${s}.html` }))];
const read = (f: string) => readFileSync(f, "utf8");
const visible = (h: string) => h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("routing: every guide URL maps to its file, with no host condition (same on matchire.ai and app.matchire.ai)", async () => {
  const { default: config } = await import("../next.config.ts");
  const { beforeFiles } = (await config.rewrites!()) as { beforeFiles: { source: string; destination: string; has?: unknown }[] };
  for (const r of beforeFiles) assert.equal(r.has, undefined, "no per-host rules");
  const route = (url: string) => {
    for (const r of beforeFiles) {
      const re = new RegExp("^" + r.source.replace(/:(\w+)\(([^)]+)\)/g, "(?<$1>$2)") + "$");
      const m = url.match(re);
      if (m) return "public" + r.destination.replace(/:(\w+)/g, (_, k) => m.groups![k]);
    }
    return "public" + url;
  };
  for (const p of PAGES) { assert.equal(route(p.url), p.file); assert.ok(existsSync(p.file), p.file); }
  assert.equal(route("/guides/guides.css"), "public/guides/guides.css", "the stylesheet isn't rewritten");
});

for (const p of PAGES) {
  test(`${p.url}: canonical, title, description, one h1, JSON-LD, text without JS`, () => {
    const h = read(p.file);
    assert.deepEqual([...h.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map((m) => m[1]), [`https://matchire.ai${p.url}`]);
    assert.match(h, /<title>[^<]{10,}<\/title>/);
    assert.match(h, /<meta name="description" content="[^"]{50,}">/);
    assert.equal((h.match(/<h1>/g) ?? []).length, 1);
    const blocks = [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1);
    const graph = JSON.parse(blocks[0][1])["@graph"];
    const types = graph.map((n: { "@type": string }) => n["@type"]);
    assert.deepEqual(types, p.url === "/guides" ? ["CollectionPage", "BreadcrumbList"] : ["Article", "BreadcrumbList"]);
    if (p.url !== "/guides") {
      const a = graph[0];
      assert.equal(a.author.name, "Giuseppe Mennella");
      assert.equal(a.publisher["@id"], "https://matchire.ai/#organization", "the landing page's Organization");
      assert.equal(a.datePublished, a.dateModified);
      assert.equal(a.headline, h.match(/<h1>([^<]+)<\/h1>/)![1]);
      assert.deepEqual(graph[1].itemListElement.map((i: { name: string }) => i.name).slice(0, 2), ["Home", "Guides"]);
    }
    const text = visible(h);
    assert.match(text, /By Giuseppe Mennella, founder of Matchire\.ai · Last updated: \d{1,2} \w+ 2026/);
    assert.match(text, /In short/);
    assert.match(text, /Matchire\.ai is the AI booking desk for event vendors in Singapore, made by MATCHIRE\.AI PTE\. LTD\. \(UEN 202546112G\)\. Not a recruiting or hotel booking service\./);
    assert.match(h, /<a href="\/guides">Guides<\/a>/, "footer Guides link");
  });
}

test("guides: no invented stats, links to each other and home, coming-soon features left out", () => {
  for (const p of PAGES) {
    const text = visible(read(p.file));
    assert.doesNotMatch(text, /\d\s?%|%\s?\d|per ?cent/i, `${p.url}: no percentages`);
    assert.doesNotMatch(text, /customers say/i);
    assert.doesNotMatch(text, /Instagram|team logins/i, "coming-soon features are left out");
  }
  for (const s of SLUGS) {
    const h = read(`public/guides/${s}.html`);
    for (const o of SLUGS.filter((x) => x !== s)) assert.match(h, new RegExp(`href="/guides/${o}"`));
    assert.match(h, /href="https:\/\/matchire\.ai\/"/);
    assert.match(h, /href="https:\/\/matchire\.ai\/#early-access"/);
    assert.equal((read(`public/guides/${s}.html`).match(/class="matchire"/g) ?? []).length, 1, "one Matchire section");
  }
  assert.equal((read("public/guides/whatsapp-enquiry-templates-event-vendors.html").match(/<div class="tpl">/g) ?? []).length, 6, "six templates");
});

test("sitemap lists the guides; the landing footer links to them", () => {
  const sm = read("public/sitemap.xml");
  for (const p of PAGES) assert.match(sm, new RegExp(`<loc>https://matchire\\.ai${p.url}</loc>\\s*<lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`));
  assert.match(read("public/landing.html"), /<footer>[\s\S]*<a href="\/guides">Guides<\/a>/);
});
