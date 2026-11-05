import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The try-it demo on the landing page is plain client-side script; these checks keep its samples honest.
const html = readFileSync("public/landing.html", "utf8");
const samples = html.slice(html.indexOf("const V={"), html.indexOf("const OFFPEAK="));

test("demo samples never hard-code a weekday with a date (they're generated, so the weekday always matches)", () => {
  const fixed = samples.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g);
  assert.equal(fixed, null, `hard-coded sample dates: ${fixed}`);
  assert.match(html, /const on=\(wd,min\)=>/);
});

test("the demo prices like the app: one 20% off-peak rate on the package only, no automatic Setup & transport", () => {
  assert.match(html, /const OFFPEAK=20;/);
  assert.doesNotMatch(html, /25% weekday daytime rate/);
  assert.doesNotMatch(samples, /Setup & transport/);
  assert.doesNotMatch(samples, /full\*\.75/, "no vendor-specific discount left");
});

test("the demo reads time ranges as a duration", () => {
  assert.match(html, /A time range \("7pm–11pm", "7-11pm", "19:00–23:00", "2pm to 4pm"\)/);
});
