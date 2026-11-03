import { after, type NextRequest } from "next/server";
import { get } from "@/lib/db";
import { fileAsOther, ingest, processEnquiry } from "@/lib/engine";
import { automatedReason, parseHeaders, type Headers } from "@/lib/automated";
import { dropIfHidden } from "@/lib/contacts";

// Inbound email. Accepts the JSON shapes Postmark and Mailgun-style routes send,
// or multipart form posts (SendGrid Inbound Parse). The token in the URL
// identifies the vendor.

function parseFrom(from: string): { name: string | null; email: string | null } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: from.includes("@") ? from.trim().toLowerCase() : null };
}

/** Drop quoted history so only the new message is read. */
function stripQuoted(text: string): string {
  const cut = text.search(/\n\s*(On .{5,120} wrote:|-{2,}\s*Original Message|From: .+\n|>)/i);
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const vendor = get<{ id: number }>("SELECT id FROM vendors WHERE inbound_token = ?", token);
  if (!vendor) return new Response("Not found", { status: 404 });

  let from = "", fromName = "", subject = "", text = "";
  let headers: Headers = {};
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const b = await req.json().catch(() => ({}));
    from = b.From ?? b.from ?? b.sender ?? "";
    fromName = b.FromName ?? b.from_name ?? "";
    subject = b.Subject ?? b.subject ?? "";
    text = b.StrippedTextReply || b.TextBody || b["stripped-text"] || b["body-plain"] || b.text || "";
    headers = parseHeaders(b.Headers ?? b["message-headers"] ?? b.headers);
  } else {
    const f = await req.formData();
    from = String(f.get("from") ?? f.get("sender") ?? "");
    subject = String(f.get("subject") ?? "");
    text = String(f.get("stripped-text") ?? f.get("text") ?? f.get("body-plain") ?? "");
    headers = parseHeaders(f.get("headers") ?? f.get("message-headers") ?? "");
  }
  const sender = parseFrom(from);
  if (!sender.email) return new Response("Missing sender", { status: 400 });
  // A sender the vendor hid: dropped here, before it's stored or read. Only counted.
  if (dropIfHidden(vendor.id, sender.email)) return Response.json({ ok: true, ignored: "hidden contact" });
  const body = stripQuoted(text);
  // Out-of-office replies, newsletters and bounces: filed under Other, never read by the AI or answered.
  const automated = automatedReason(headers, from, subject);
  if (automated) {
    const r = fileAsOther({ vendorId: vendor.id, channel: "email", text: subject ? `${subject}\n\n${body}` : body, name: fromName || sender.name, handle: sender.email, email: sender.email, reason: automated });
    return Response.json({ ok: true, filed: automated, enquiryId: r.enquiryId });
  }
  if (!body) return Response.json({ ok: true, ignored: "empty" });

  const { enquiryId } = ingest({
    vendorId: vendor.id,
    channel: "email",
    text: subject && !/^re:/i.test(subject) ? `${subject}\n\n${body}` : body,
    name: fromName || sender.name,
    handle: sender.email,
    email: sender.email,
  });
  after(() => processEnquiry(vendor.id, enquiryId).catch((e) => console.error("Email processing failed", e)));
  return Response.json({ ok: true, enquiryId });
}
