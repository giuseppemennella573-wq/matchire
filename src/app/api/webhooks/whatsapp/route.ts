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
    return new Response(p.get("hub.challenge") ?? "", { status: 200 });
  }
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
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return new Response("Bad signature", { status: 401 });
  }
  let body: WaPayload;
  try { body = JSON.parse(raw); } catch { return new Response("Bad JSON", { status: 400 }); }

  const jobs: { vendorId: number; enquiryId: number }[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const vendor = value?.metadata?.phone_number_id
        ? get<{ id: number }>("SELECT id FROM vendors WHERE wa_phone_number_id = ?", value.metadata.phone_number_id)
        : undefined;
      if (!vendor) continue;
      for (const m of value?.messages ?? []) {
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title;
        if (!text || !m.from) continue; // media and reactions are ignored for now
        const contact = value?.contacts?.find((c) => c.wa_id === m.from);
        const { enquiryId } = ingest({ vendorId: vendor.id, channel: "whatsapp", text, name: contact?.profile?.name ?? null, handle: "+" + m.from });
        jobs.push({ vendorId: vendor.id, enquiryId });
      }
    }
  }
  after(async () => {
    for (const j of jobs) await processEnquiry(j.vendorId, j.enquiryId).catch((e) => console.error("WhatsApp processing failed", e));
  });
  return Response.json({ ok: true });
}
