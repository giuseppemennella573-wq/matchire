"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireVendor } from "@/lib/auth";
import { get, run } from "@/lib/db";
import * as E from "@/lib/engine";
import { aiEnabled, aiImportPriceList } from "@/lib/ai";
import { addItems, token } from "@/lib/accounts";
import { changePassword } from "@/lib/password-reset";
import { channelChangesFromForm, requestChannelSetup, updateChannels } from "@/lib/channel-settings";
import { settingsUpdate, tabFromHash } from "@/lib/settings-tabs";
import { isAdmin } from "@/lib/early-access";
import { appUrl } from "@/lib/app-url";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { isValidIsoDate } from "@/lib/dates";
import type { Channel, Item } from "@/lib/types";

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
    else if (intent === "price_anyway") {
      await E.sendPriceAnyway(vendor.id, eid);
      back(path, "Quote drafted. Check it before it goes out.");
    } else if (intent === "regenerate") {
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
  if (!aiEnabled()) back("/app/prices", "Importing a rate card needs AI to be switched on.", "error");
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
  const partner = get<{ id: number; name: string; is_demo: number }>("SELECT id, name, is_demo FROM vendors WHERE slug = ?", code);
  if (!partner) back("/app/partners", "No vendor has that partner code.", "error");
  if (partner!.id === vendor.id) back("/app/partners", "That's your own code.", "error");
  // A real planner must never be passed into a demo account that prospects look at.
  if (!E.canPartner(partner!, vendor)) back("/app/partners", "Demo accounts can only partner with other demo accounts.", "error");
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

/** Save one Settings tab. Only that tab's fields are written (see settingsUpdate). */
export async function saveSettingsTabAction(form: FormData) {
  const { user, vendor } = await requireVendor();
  const tab = tabFromHash(str(form, "tab"));
  const cols = Object.entries(settingsUpdate(tab, form, vendor));
  if (cols.length) run(`UPDATE vendors SET ${cols.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...cols.map(([, v]) => v), vendor.id);
  // Channel connections and template approval are set by Matchire admins only; anyone else's fields are ignored.
  if (isAdmin(user)) {
    const actor = { id: user.id, email: user.email, admin: true };
    if (tab === "channels") {
      const c = channelChangesFromForm(form);
      await updateChannels(vendor.id, { phoneNumberId: c.phoneNumberId, token: c.token, disconnect: c.disconnect }, actor);
    }
    if (tab === "ai") await updateChannels(vendor.id, { templatesApproved: form.get("wa_templates_approved") === "on" }, actor);
  }
  revalidatePath("/app", "layout");
  redirect(`/app/settings?tab=${tab}&saved=1`);
}

export async function rotateInboundTokenAction(form: FormData) {
  const { vendor } = await requireVendor();
  if (form.get("confirm") !== "on") back("/app/settings?tab=channels", "Tick the box to confirm you want a new address.", "error");
  run("UPDATE vendors SET inbound_token = ? WHERE id = ?", token(12).toLowerCase().replace(/[^a-z0-9]/g, "x"), vendor.id);
  back("/app/settings?tab=channels", "New forwarding address generated. Update your forwarding rule.");
}

function isRedirect(e: unknown): boolean {
  return typeof e === "object" && e !== null && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_REDIRECT");
}

export async function changePasswordAction(form: FormData) {
  const { user } = await requireVendor();
  const next = String(form.get("new_password") ?? "");
  if (next !== String(form.get("confirm_password") ?? "")) back("/app/settings?tab=account", "The two new passwords don't match.", "error");
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  const error = changePassword(user.id, String(form.get("current_password") ?? ""), next, session);
  if (error) back("/app/settings?tab=account", error, "error");
  back("/app/settings?tab=account", "Password changed. You've been logged out on other devices.");
}

export async function requestSetupAction(form: FormData) {
  const { user, vendor } = await requireVendor();
  const channel = form.get("channel") === "email" ? "email" : "whatsapp";
  const label = channel === "email" ? "email forwarding" : "WhatsApp";
  const r = await requestChannelSetup(vendor, user, channel, appUrl());
  if (r === "sent") back("/app/settings?tab=channels", `Request sent. We'll be in touch to set up ${label}.`);
  if (r === "already_requested") back("/app/settings?tab=channels", `You've already asked for ${label} setup today. We'll be in touch.`);
  if (r === "demo") back("/app/settings?tab=channels", "Demo account: the request was simulated, nothing was sent.");
  back("/app/settings?tab=channels", `Couldn't send the request (${r.replace(/\.$/, "")}). Email us at hello@matchire.ai instead.`, "error");
}
