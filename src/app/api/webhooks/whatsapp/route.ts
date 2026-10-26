import { after, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { get } from "@/lib/db";
import { ingest, processEnquiry } from "@/lib/engine";

// WhatsApp Cloud API webhook. Meta calls GET once to verify the URL, then
// POSTs every inbound message. We acknowledge at once and do the work after.

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (p.get("hub.mode") === "subscribe" && expected && p.get("hub.verify_token") === expected) {
    console.log("[whatsapp] webhook verified by Meta");
    return new Response(p.get("hub.challenge") ?? "", { status: 200 });
  }
  console.warn(`[whatsapp] webhook verification refused (${expected ? "token mismatch" : "WHATSAPP_VERIFY_TOKEN not set"})`);
  return new Response("Forbidden", { status: 403 });
}

interface WaPayload {
  entry?: { changes?: { value?: {
    metadata?: { phone_number_id?: string };
    contacts?: { wa_id?: string; profile?: { name?: string } }[];
    messages?: { from?: string; type?: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string } } }[];
  } }[] }[];
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (secret) {
    const sig = req.headers.get("x-hub-signature-256") ?? "";
    const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      console.warn(`[whatsapp] rejected a webhook: signature ${sig ? "doesn't match WHATSAPP_APP_SECRET" : "missing"}`);
      return new Response("Bad signature", { status: 401 });
    }
  }
  let body: WaPayload;
  try { body = JSON.parse(raw); } catch { console.warn("[whatsapp] webhook body is not JSON"); return new Response("Bad JSON", { status: 400 }); }
  console.log(`[whatsapp] webhook received (${raw.length} bytes)`);

  const jobs: { vendorId: number; enquiryId: number }[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const vendor = value?.metadata?.phone_number_id
        ? get<{ id: number }>("SELECT id FROM vendors WHERE wa_phone_number_id = ?", value.metadata.phone_number_id)
        : undefined;
      const pnid = value?.metadata?.phone_number_id;
      if (!value?.messages?.length) continue; // delivery/read receipts and template updates
      if (!vendor) {
        console.warn(`[whatsapp] message for phone number ID ${pnid ?? "(none)"} ignored: no vendor has that ID in Settings`);
        continue;
      }
      for (const m of value.messages) {
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title;
        if (!text || !m.from) { console.log(`[whatsapp] ignored a ${m.type ?? "non-text"} message`); continue; } // media and reactions aren't handled yet
        const contact = value?.contacts?.find((c) => c.wa_id === m.from);
        const { enquiryId } = ingest({ vendorId: vendor.id, channel: "whatsapp", text, name: contact?.profile?.name ?? null, handle: "+" + m.from });
        jobs.push({ vendorId: vendor.id, enquiryId });
        console.log(`[whatsapp] message from +${m.from} → enquiry ${enquiryId} (vendor ${vendor.id})`);
      }
    }
  }
  after(async () => {
    for (const j of jobs) await processEnquiry(j.vendorId, j.enquiryId).catch((e) => console.error("WhatsApp processing failed", e));
  });
  return Response.json({ ok: true });
}
