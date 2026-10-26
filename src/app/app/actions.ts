"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireVendor } from "@/lib/auth";
import { get, run } from "@/lib/db";
import * as E from "@/lib/engine";
import { aiEnabled, aiImportPriceList } from "@/lib/ai";
import { addItems, token } from "@/lib/accounts";
import { isValidIsoDate } from "@/lib/dates";
import type { Channel, Item, VendorKind } from "@/lib/types";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => {
  const s = str(f, k);
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const id = (f: FormData, k: string) => {
  const n = Number(f.get(k));
  if (!Number.isInteger(n) || n <= 0) throw new Error("Bad request");
  return n;
};
const back = (path: string, msg?: string, kind: "msg" | "error" = "msg"): never =>
  redirect(msg ? `${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(msg)}` : path);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

// ---------- Enquiries ----------

export async function newEnquiryAction(form: FormData) {
  const { vendor } = await requireVendor();
  const text = str(form, "text");
  if (!text) back("/app/inbox", "Paste the planner's message first.", "error");
  const contact = str(form, "contact");
  const { enquiryId } = E.ingest({
    vendorId: vendor.id,
    channel: (str(form, "channel") || "manual") as Channel,
    text,
    name: str(form, "name") || null,
    handle: contact || null,
    email: contact.includes("@") ? contact : null,
  });
  await E.processEnquiry(vendor.id, enquiryId);
  redirect(`/app/inbox/${enquiryId}`);
}

export async function plannerReplyAction(form: FormData) {
  const { vendor } = await requireVendor();
  const eid = id(form, "enquiryId");
  const text = str(form, "text");
  if (text) {
    E.appendInbound(vendor.id, eid, text);
    await E.processEnquiry(vendor.id, eid);
  }
  redirect(`/app/inbox/${eid}`);
}

export async function draftAction(form: FormData) {
  const { vendor } = await requireVendor();
  const mid = id(form, "messageId");
  const eid = id(form, "enquiryId");
  const body = str(form, "body");
  const path = `/app/inbox/${eid}`;
  const intent = str(form, "intent");
  try {
    if (intent === "discard") E.discardDraft(vendor.id, mid);
    else if (intent === "manual") E.markDraftSentManually(vendor.id, mid, body);
    else if (intent === "regenerate") {
      E.discardDraft(vendor.id, mid);
      await E.processEnquiry(vendor.id, eid);
    } else {
      const r = await E.sendDraft(vendor.id, mid, { body, markBooked: intent === "send_book" });
      if (r.status === "failed") back(path, `Couldn't send: ${r.error}`, "error");
      if (r.status === "manual") back(path); // the draft itself now explains what to do
      back(path, `Sent on ${r.via}.`);
    }
  } catch (e) {
    if (isRedirect(e)) throw e;
    back(path, errMsg(e), "error");
  }
  redirect(path);
}

export async function outcomeAction(form: FormData) {
  const { vendor } = await requireVendor();
  const eid = id(form, "enquiryId");
  const intent = str(form, "intent");
  if (intent === "booked") E.markBooked(vendor.id, eid, num(form, "value") ?? undefined);
  else if (intent === "lost") E.markLost(vendor.id, eid);
  else if (intent === "reopen") E.reopen(vendor.id, eid);
  else if (intent === "reprocess") await E.processEnquiry(vendor.id, eid);
  revalidatePath("/app", "layout");
  redirect(`/app/inbox/${eid}`);
}

export async function deleteEnquiryAction(form: FormData) {
  const { vendor } = await requireVendor();
  E.deleteEnquiry(vendor.id, id(form, "enquiryId"));
  revalidatePath("/app", "layout");
  back("/app/inbox?filter=all", "Enquiry deleted.");
}

export async function noteAction(form: FormData) {
  const { vendor } = await requireVendor();
  const eid = id(form, "enquiryId");
  if (str(form, "body")) E.addNote(vendor.id, eid, str(form, "body"));
  redirect(`/app/inbox/${eid}`);
}

export async function referAction(form: FormData) {
  const { vendor } = await requireVendor();
  const eid = id(form, "enquiryId");
  try {
    await E.referToPartner(vendor.id, eid, id(form, "partnerId"));
  } catch (e) {
    back(`/app/inbox/${eid}`, errMsg(e), "error");
  }
  back(`/app/inbox/${eid}`, "Referred. Your partner has the enquiry, and a note to the planner is drafted below.");
}

// ---------- Price list ----------

export async function saveItemAction(form: FormData) {
  const { vendor } = await requireVendor();
  const itemId = num(form, "id");
  const name = str(form, "name");
  const price = num(form, "price");
  if (!name || price == null || price < 0) back("/app/prices", "Every item needs a name and a price.", "error");
  const pricing = (["flat", "per_hour", "per_pax"].includes(str(form, "pricing")) ? str(form, "pricing") : "flat") as Item["pricing"];
  const kind = str(form, "kind") === "addon" ? "addon" : "package";
  const vals = [kind, name, str(form, "description"), pricing, price, num(form, "included_hours"), num(form, "extra_hour_price"), num(form, "min_pax"), num(form, "max_pax"), form.get("active") === "on" ? 1 : 0] as const;
  if (itemId) {
    run(
      `UPDATE items SET kind = ?, name = ?, description = ?, pricing = ?, price = ?, included_hours = ?, extra_hour_price = ?, min_pax = ?, max_pax = ?, active = ? WHERE id = ? AND vendor_id = ?`,
      ...vals, itemId, vendor.id,
    );
  } else {
    run(
      `INSERT INTO items (kind, name, description, pricing, price, included_hours, extra_hour_price, min_pax, max_pax, active, vendor_id, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 99)`,
      ...vals, vendor.id,
    );
  }
  back("/app/prices", "Saved.");
}

export async function deleteItemAction(form: FormData) {
  const { vendor } = await requireVendor();
  run("DELETE FROM items WHERE id = ? AND vendor_id = ?", id(form, "id"), vendor.id);
  back("/app/prices", "Deleted.");
}

export async function activateImportedAction() {
  const { vendor } = await requireVendor();
  run("UPDATE items SET active = 1 WHERE vendor_id = ? AND active = 0", vendor.id);
  back("/app/prices", "All items are live.");
}

export async function importPriceListAction(form: FormData) {
  const { vendor } = await requireVendor();
  if (!aiEnabled()) back("/app/prices", "Importing a rate card needs a Claude API key (ANTHROPIC_API_KEY).", "error");
  const text = str(form, "text");
  const file = form.get("file");
  let upload: { mediaType: string; base64: string } | undefined;
  if (file instanceof File && file.size > 0) {
    const ok = ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"];
    if (!ok.includes(file.type)) back("/app/prices", "Upload a PDF, PNG, JPG or WebP.", "error");
    if (file.size > 10 * 1024 * 1024) back("/app/prices", "That file is over 10 MB.", "error");
    upload = { mediaType: file.type, base64: Buffer.from(await file.arrayBuffer()).toString("base64") };
  }
  if (!text && !upload) back("/app/prices", "Paste your rate card or upload a file.", "error");
  try {
    const out = await aiImportPriceList({ text, file: upload });
    addItems(vendor.id, out.items.map((i) => ({ ...i, description: i.description ?? "" })), false);
    if (out.notes.trim()) run("UPDATE vendors SET notes = TRIM(notes || char(10) || ?) WHERE id = ?", out.notes.trim(), vendor.id);
    back("/app/prices", `Imported ${out.items.length} items for review. Check each one, then make them live.`);
  } catch (e) {
    if (isRedirect(e)) throw e;
    back("/app/prices", `Import failed: ${errMsg(e)}`, "error");
  }
}

// ---------- Calendar ----------

export async function blockDateAction(form: FormData) {
  const { vendor } = await requireVendor();
  const date = str(form, "date");
  if (!isValidIsoDate(date)) back("/app/calendar", "Pick a date.", "error");
  E.blockDate(vendor.id, date, str(form, "note"));
  back(`/app/calendar?month=${date.slice(0, 7)}`, "Date blocked.");
}

export async function releaseHoldAction(form: FormData) {
  const { vendor } = await requireVendor();
  E.releaseHold(vendor.id, id(form, "holdId"));
  back(str(form, "back") || "/app/calendar", "Released.");
}

// ---------- Partners ----------

export async function invitePartnerAction(form: FormData) {
  const { vendor } = await requireVendor();
  const code = str(form, "code").toLowerCase().replace(/^.*\/e\//, "");
  const partner = get<{ id: number; name: string }>("SELECT id, name FROM vendors WHERE slug = ?", code);
  if (!partner) back("/app/partners", "No vendor has that partner code.", "error");
  if (partner!.id === vendor.id) back("/app/partners", "That's your own code.", "error");
  const existing = get<{ id: number; status: string; requester_id: number }>(
    "SELECT * FROM partnerships WHERE (requester_id = ? AND partner_id = ?) OR (requester_id = ? AND partner_id = ?)",
    vendor.id, partner!.id, partner!.id, vendor.id,
  );
  if (existing?.status === "accepted") back("/app/partners", `You're already partners with ${partner!.name}.`);
  if (existing && existing.requester_id === partner!.id && existing.status === "pending") {
    run("UPDATE partnerships SET status = 'accepted' WHERE id = ?", existing.id);
    back("/app/partners", `You and ${partner!.name} are now partners.`);
  }
  if (existing) run("UPDATE partnerships SET status = 'pending' WHERE id = ?", existing.id);
  else run("INSERT INTO partnerships (requester_id, partner_id) VALUES (?, ?)", vendor.id, partner!.id);
  back("/app/partners", `Request sent to ${partner!.name}.`);
}

export async function respondPartnerAction(form: FormData) {
  const { vendor } = await requireVendor();
  const pid = id(form, "id");
  const intent = str(form, "intent");
  if (intent === "remove") run("DELETE FROM partnerships WHERE id = ? AND (requester_id = ? OR partner_id = ?)", pid, vendor.id, vendor.id);
  else run("UPDATE partnerships SET status = ? WHERE id = ? AND partner_id = ? AND status = 'pending'", intent === "accept" ? "accepted" : "declined", pid, vendor.id);
  back("/app/partners");
}

// ---------- Settings ----------

export async function saveSettingsAction(form: FormData) {
  const { vendor } = await requireVendor();
  const n = (k: string, fallback: number, min = 0) => Math.max(min, num(form, k) ?? fallback);
  run(
    `UPDATE vendors SET name = ?, kind = ?, tone = ?, signoff = ?, notes = ?, deposit_note = ?, capacity = ?, jobs_per_day = ?, min_spend = ?,
     offpeak_discount = ?, auto_send = ?, hold_hours = ?, followup_days = ?, bundle_suggestions = ?, referral_fee_pct = ?,
     wa_phone_number_id = ?, wa_token = COALESCE(NULLIF(?, ''), wa_token) WHERE id = ?`,
    str(form, "name") || vendor.name,
    (str(form, "kind") || vendor.kind) as VendorKind,
    str(form, "tone") || vendor.tone,
    str(form, "signoff"),
    str(form, "notes"),
    str(form, "deposit_note"),
    num(form, "capacity"),
    n("jobs_per_day", 1, 1),
    n("min_spend", 0),
    Math.min(90, n("offpeak_discount", 0)),
    form.get("auto_send") === "on" ? 1 : 0,
    n("hold_hours", 48, 1),
    n("followup_days", 2, 0.5),
    form.get("bundle_suggestions") === "on" ? 1 : 0,
    Math.min(50, n("referral_fee_pct", 10)),
    str(form, "wa_phone_number_id") || null,
    str(form, "wa_token"),
    vendor.id,
  );
  if (form.get("wa_disconnect") === "on") run("UPDATE vendors SET wa_phone_number_id = NULL, wa_token = NULL WHERE id = ?", vendor.id);
  revalidatePath("/app", "layout");
  back("/app/settings", "Settings saved.");
}

export async function rotateInboundTokenAction() {
  const { vendor } = await requireVendor();
  run("UPDATE vendors SET inbound_token = ? WHERE id = ?", token(12).toLowerCase().replace(/[^a-z0-9]/g, "x"), vendor.id);
  back("/app/settings", "New inbound email address generated. Update your forwarding rule.");
}

function isRedirect(e: unknown): boolean {
  return typeof e === "object" && e !== null && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_REDIRECT");
}
