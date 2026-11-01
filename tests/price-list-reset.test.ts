import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MATCHIRE_DB = path.join(mkdtempSync(path.join(tmpdir(), "matchire-reset-")), "test.db");
delete process.env.ANTHROPIC_API_KEY;

const { createAccount, addItems } = await import("../src/lib/accounts.ts");
const E = await import("../src/lib/engine.ts");
const { run, get } = await import("../src/lib/db.ts");

const base = { kind: "package" as const, pricing: "flat" as const, description: "", included_hours: 3, extra_hour_price: 180, min_pax: null, max_pax: null };
let mine: number, theirs: number;
before(() => {
  mine = createAccount({ email: "mine@test.sg", password: "password1", name: "A", business: "Mine", kind: "photobooth" }).vendorId;
  theirs = createAccount({ email: "theirs@test.sg", password: "password1", name: "B", business: "Theirs", kind: "photobooth" }).vendorId;
  addItems(theirs, [{ ...base, name: "Their booth", price: 500 }]);
});

test("'Discard these' removes only the items that aren't live", () => {
  addItems(mine, [{ ...base, name: "Live booth", price: 850 }]); // live
  addItems(mine, [{ ...base, name: "Imported A", price: 600 }, { ...base, name: "Imported B", price: 700 }], false); // just imported
  assert.equal(E.discardPendingItems(mine), 2);
  assert.deepEqual(E.getItems(mine).map((i) => i.name), ["Live booth"]);
  assert.equal(E.getItems(theirs).length, 1, "another vendor's items are untouched");
});

test("'Delete all items' empties this vendor's list only; sent quotes and business notes stay", async () => {
  run("UPDATE vendors SET notes = '30% deposit secures the date.' WHERE id = ?", mine);
  addItems(mine, [{ ...base, name: "Imported C", price: 650 }], false);
  const { enquiryId } = E.ingest({ vendorId: mine, channel: "manual", handle: "+65 9111 1111", text: "Live booth for our party on 12 Dec evening, 80 guests, 3 hours" });
  await E.processEnquiry(mine, enquiryId);
  const quoteBefore = E.getEnquiry(mine, enquiryId)!.quote;
  assert.ok(quoteBefore && E.parseQuote(E.getEnquiry(mine, enquiryId)!)!.total > 0);

  assert.equal(E.clearPriceList(mine), 2);
  assert.equal(E.getItems(mine).length, 0);
  assert.equal(E.getItems(theirs).length, 1, "another vendor's items are untouched");
  assert.equal(E.getEnquiry(mine, enquiryId)!.quote, quoteBefore, "the quote already made keeps its prices");
  assert.equal(get<{ notes: string }>("SELECT notes FROM vendors WHERE id = ?", mine)!.notes, "30% deposit secures the date.");
});
