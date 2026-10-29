import { createTransport, type Transporter } from "nodemailer";
import type { Enquiry, Vendor } from "./types.ts";
import { get, run } from "./db.ts";

// Outbound delivery. WhatsApp goes through the Meta WhatsApp Cloud API using
// the vendor's own business number. Email goes out over SMTP (e.g. a Google
// Workspace mailbox) when SMTP_* is set, otherwise through Resend. Channels that
// have no API (Instagram DMs, manual entries) are marked for the vendor to
// copy and send themselves.

export type SendResult = { status: "sent" | "manual" | "failed"; error?: string; via: string };

const GRAPH = "https://graph.facebook.com/v21.0";

export function whatsappReady(v: Vendor): boolean {
  return Boolean(v.wa_phone_number_id && v.wa_token);
}
const smtpReady = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

export function emailReady(): boolean {
  return smtpReady() || Boolean(process.env.RESEND_API_KEY);
}

let smtp: Transporter | null = null;
function smtpTransport(): Transporter {
  const port = Number(process.env.SMTP_PORT || 465);
  smtp ??= createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return smtp;
}

/** Gmail rejects or rewrites a From address the account doesn't own, so default to the mailbox itself. */
const fromAddress = () => process.env.EMAIL_FROM || (smtpReady() ? `Matchire <${process.env.SMTP_USER}>` : "Matchire <bookings@matchire.ai>");

async function postWhatsApp(v: Vendor, to: string, message: object): Promise<SendResult> {
  const res = await fetch(`${GRAPH}/${v.wa_phone_number_id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${v.wa_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: to.replace(/[^\d]/g, ""), ...message }),
  });
  if (res.ok) return { status: "sent", via: "WhatsApp" };
  const err = await res.text().catch(() => "");
  console.warn(`[whatsapp] send failed ${res.status}: ${err.slice(0, 300)}`);
  // 131047: outside the 24-hour customer service window; a template message is required.
  return { status: "failed", via: "WhatsApp", error: `WhatsApp API ${res.status}: ${err.slice(0, 300)}` };
}

const sendWhatsApp = (v: Vendor, to: string, body: string) => postWhatsApp(v, to, { type: "text", text: { body, preview_url: false } });

/** A pre-approved WhatsApp template, the only kind of message allowed outside the 24-hour window. */
export interface WaTemplate { name: string; params: string[] }

/** Must match the language chosen when the template was submitted in WhatsApp Manager. */
const TEMPLATE_LANGUAGE = "en";

const phoneOf = (e: Enquiry) => (e.contact_handle && /^\+?\d[\d\s-]{6,}$/.test(e.contact_handle) ? e.contact_handle : null);

/** True when replies to this enquiry go out through the WhatsApp Cloud API (and so are bound by its 24-hour window). */
export function viaWhatsAppApi(v: Vendor, e: Enquiry): boolean {
  return e.channel === "whatsapp" && phoneOf(e) !== null && whatsappReady(v);
}

export async function deliverTemplate(v: Vendor, e: Enquiry, t: WaTemplate): Promise<SendResult> {
  if (!viaWhatsAppApi(v, e)) return { status: "manual", via: "WhatsApp", error: "WhatsApp isn't connected yet. Copy the reply and send it from your phone." };
  try {
    return await postWhatsApp(v, phoneOf(e)!, {
      type: "template",
      template: { name: t.name, language: { code: TEMPLATE_LANGUAGE }, components: [{ type: "body", parameters: t.params.map((text) => ({ type: "text", text })) }] },
    });
  } catch (err) {
    return { status: "failed", via: "WhatsApp", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Send a plain-text email over SMTP or Resend. Returns an error message on failure. */
export interface Attachment { filename: string; content: Buffer; contentType: string }

export async function sendRawEmail(m: { to: string; subject: string; text: string; replyTo?: string | null; attachments?: Attachment[] }): Promise<string | null> {
  if (!emailReady()) return "Outbound email isn't configured (set SMTP_HOST, SMTP_USER and SMTP_PASS).";
  const error = await sendViaProvider(m).catch((e) => (e instanceof Error ? e.message : String(e)));
  recordEmailResult(error);
  return error;
}

// ---------- Email health ----------
// The outcome of the latest send, so admins see a warning on every page when
// email stops working (e.g. a revoked Gmail app password), not days later.

export interface EmailHealth { ok: boolean; error: string | null; since: string | null }

function recordEmailResult(error: string | null) {
  const now = new Date().toISOString();
  const prev = emailHealth();
  // Keep the time of the first failure in a run, so the warning says how long it's been broken.
  const since = error ? (prev.ok ? now : prev.since ?? now) : now;
  run(
    "INSERT INTO app_status (key, value, updated_at) VALUES ('email', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    JSON.stringify({ ok: !error, error, since } satisfies EmailHealth), now,
  );
}

/** Whether the latest email went out. With no sends yet, email counts as working. */
export function emailHealth(): EmailHealth {
  const row = get<{ value: string }>("SELECT value FROM app_status WHERE key = 'email'");
  try { return row ? (JSON.parse(row.value) as EmailHealth) : { ok: true, error: null, since: null }; } catch { return { ok: true, error: null, since: null }; }
}

async function sendViaProvider(m: { to: string; subject: string; text: string; replyTo?: string | null; attachments?: Attachment[] }): Promise<string | null> {
  if (smtpReady()) {
    try {
      await smtpTransport().sendMail({ from: fromAddress(), to: m.to, subject: m.subject, text: m.text, replyTo: m.replyTo ?? undefined, attachments: m.attachments });
      return null;
    } catch (e) {
      return `Email (SMTP) failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400);
    }
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: fromAddress(),
      to: [m.to],
      subject: m.subject,
      text: m.text,
      reply_to: m.replyTo ?? undefined,
      attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content.toString("base64") })),
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
    const phone = phoneOf(e);
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
