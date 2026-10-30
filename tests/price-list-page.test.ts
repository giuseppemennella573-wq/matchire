import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { priceListMode } from "../src/lib/pricing.ts";

test("an empty price list opens on the import, or on adding by hand", () => {
  assert.equal(priceListMode(0, true, false), "import-first");
  assert.equal(priceListMode(0, true, true), "manual", "the 'or add packages by hand' link");
  assert.equal(priceListMode(0, false, false), "manual", "no AI, nothing to import with");
  assert.equal(priceListMode(3, true, false), "list");
  assert.equal(priceListMode(3, false, true), "list");
});

test("the price list page has the first-time import card and the header Import button", () => {
  const page = readFileSync("src/app/app/prices/page.tsx", "utf8");
  assert.match(page, /<h2>Upload your rate card<\/h2>/);
  assert.match(page, /PDF, photo, or paste the text\. We&apos;ll turn it into packages you can edit\./);
  assert.match(page, /href="\/app\/prices\?manual=1#add-package">or add packages by hand</);
  assert.match(page, /\{!empty && <a className="btn btn-ghost btn-sm" href="#import">Import<\/a>\}/);
  // One import form, used in both places.
  assert.equal(page.match(/action=\{importPriceListAction\}/g)?.length, 1);
});

test("the import form appears once on the page in every mode", () => {
  const page = readFileSync("src/app/app/prices/page.tsx", "utf8");
  assert.match(page, /\{\(mode === "list" \|\| \(mode === "manual" && aiEnabled\(\)\)\) && \(/, "the bottom import card is hidden while the first-time card is showing");
});
