import type { Enquiry, Vendor } from "./types.ts";

// Outbound delivery. WhatsApp goes through the Meta WhatsApp Cloud API using
// the vendor's own business number; email goes through Resend. Channels that
// have no API (Instagram DMs, manual entries) are marked for the vendor to
// copy and send themselves.

export type SendResult = { status: "sent" | "manual" | "failed"; error?: string; via: string };

const GRAPH = "https://graph.facebook.com/v21.0";

export function whatsappReady(v: Vendor): boolean {
  return Boolean(v.wa_phone_number_id && v.wa_token);
}
export function emailReady(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

async function sendWhatsApp(v: Vendor, to: string, body: string): Promise<SendResult> {
  const res = await fetch(`${GRAPH}/${v.wa_phone_number_id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${v.wa_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: to.replace(/[^\d]/g, ""), type: "text", text: { body, preview_url: false } }),
  });
  if (res.ok) return { status: "sent", via: "WhatsApp" };
  const err = await res.text().catch(() => "");
  // 131047: outside the 24-hour customer service window; a template message is required.
  return { status: "failed", via: "WhatsApp", error: `WhatsApp API ${res.status}: ${err.slice(0, 300)}` };
}

/** Send a plain-text email through Resend. Returns an error message on failure. */
export async function sendRawEmail(m: { to: string; subject: string; text: string; replyTo?: string | null }): Promise<string | null> {
  if (!emailReady()) return "Outbound email isn't configured (RESEND_API_KEY is not set).";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "Matchire <bookings@matchire.ai>",
      to: [m.to],
      subject: m.subject,
      text: m.text,
      reply_to: m.replyTo ?? undefined,
    }),
  });
  if (res.ok) return null;
  return `Email API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
}

async function sendEmail(v: Vendor, to: string, subject: string, body: string): Promise<SendResult> {
  const error = await sendRawEmail({ to, subject, text: body, replyTo: inboundAddress(v) });
  return error ? { status: "failed", via: "email", error } : { status: "sent", via: "email" };
}

/** The address planners' email replies should come back to, if an inbound domain is set up. */
export function inboundAddress(v: Vendor): string | null {
  const domain = process.env.INBOUND_EMAIL_DOMAIN;
  return domain ? `${v.inbound_token}@${domain}` : null;
}

export async function deliver(v: Vendor, e: Enquiry, body: string): Promise<SendResult> {
  try {
    const phone = e.contact_handle && /^\+?\d[\d\s-]{6,}$/.test(e.contact_handle) ? e.contact_handle : null;
    const email = e.contact_email || (e.contact_handle?.includes("@") ? e.contact_handle : null);
    const subject = `Re: your enquiry with ${v.name}`;

    if (e.channel === "whatsapp" && phone) {
      return whatsappReady(v) ? await sendWhatsApp(v, phone, body) : { status: "manual", via: "WhatsApp", error: "WhatsApp isn't connected yet. Copy the reply and send it from your phone." };
    }
    if (e.channel === "email" || ((e.channel === "web" || e.channel === "referral") && email)) {
      if (email && emailReady()) return await sendEmail(v, email, subject, body);
      if (!email) return { status: "manual", via: "email", error: "No email address on this enquiry." };
      return { status: "manual", via: "email", error: "Outbound email isn't configured. Copy the reply into your inbox." };
    }
    if ((e.channel === "web" || e.channel === "referral") && phone && whatsappReady(v)) return await sendWhatsApp(v, phone, body);
    return { status: "manual", via: e.channel, error: "This channel has no direct connection. Copy the reply and send it yourself." };
  } catch (err) {
    return { status: "failed", via: e.channel, error: err instanceof Error ? err.message : String(err) };
  }
}
