import { all, get, run, tx } from "./db.ts";
import { inboundAddress, sendRawEmail, whatsappReady } from "./channels.ts";
import { ALERT_TO } from "./early-access.ts";
import { formatDateTime } from "./dates.ts";
import type { Vendor } from "./types.ts";
import { token, userForSession } from "./accounts.ts";
import { isAdmin } from "./early-access.ts";

// What a vendor sees about their channels, and how they change. Vendors get a
// plain view (status, number, forwarding address, form link); the technical
// details (tokens, IDs, webhook URLs) are only ever handed to admins, and every
// admin change to a vendor's channels is logged (never the token itself).

const GRAPH = "https://graph.facebook.com/v21.0";
const RECEIVING_DAYS = 30;

export type SetupChannel = "whatsapp" | "email";

export interface ChannelView {
  whatsapp: { connected: boolean; number: string | null; setupRequestedAt: string | null };
  email: { address: string | null; receiving: boolean; lastReceivedAt: string | null; setupRequestedAt: string | null };
  form: { url: string; embedUrl: string };
  instagram: { comingSoon: true };
  /** Present only for admins. */
  technical?: {
    whatsappWebhookUrl: string;
    phoneNumberId: string | null;
    tokenMasked: string | null;
    templatesApproved: boolean;
    emailWebhookUrl: string;
  };
}

/** "EAAG…1234" → "••••1234". Admins never see a saved token in full. */
export function maskToken(t: string | null | undefined): string | null {
  if (!t) return null;
  return `••••${t.slice(-4)}`;
}

export function lastEmailReceivedAt(vendorId: number): string | null {
  return get<{ at: string | null }>(
    `SELECT MAX(m.created_at) at FROM messages m JOIN enquiries e ON e.id = m.enquiry_id
     WHERE e.vendor_id = ? AND e.channel = 'email' AND m.direction = 'in'`,
    vendorId,
  )?.at ?? null;
}

const lastRequest = (vendorId: number, channel: SetupChannel) =>
  get<{ at: string }>("SELECT MAX(created_at) at FROM setup_requests WHERE vendor_id = ? AND channel = ?", vendorId, channel)?.at ?? null;

export function channelView(v: Vendor, opts: { admin: boolean; appUrl: string; now?: Date }): ChannelView {
  const now = opts.now ?? new Date();
  const last = lastEmailReceivedAt(v.id);
  const view: ChannelView = {
    whatsapp: { connected: whatsappReady(v), number: whatsappReady(v) ? v.wa_display_number : null, setupRequestedAt: lastRequest(v.id, "whatsapp") },
    email: {
      address: inboundAddress(v),
      receiving: !!last && now.getTime() - new Date(last).getTime() < RECEIVING_DAYS * 86400_000,
      lastReceivedAt: last,
      setupRequestedAt: lastRequest(v.id, "email"),
    },
    form: { url: `${opts.appUrl}/e/${v.slug}`, embedUrl: `${opts.appUrl}/e/${v.slug}?embed=1` },
    instagram: { comingSoon: true },
  };
  if (opts.admin) {
    view.technical = {
      whatsappWebhookUrl: `${opts.appUrl}/api/webhooks/whatsapp`,
      phoneNumberId: v.wa_phone_number_id,
      tokenMasked: maskToken(v.wa_token),
      templatesApproved: !!v.wa_templates_approved,
      emailWebhookUrl: `${opts.appUrl}/api/webhooks/email/${v.inbound_token}`,
    };
  }
  return view;
}

// ---------- Changes (admins only) ----------

export interface ChannelChanges {
  phoneNumberId?: string | null;
  /** A new token; blank or missing keeps the saved one. */
  token?: string;
  disconnect?: boolean;
  templatesApproved?: boolean;
  rotateInbound?: boolean;
}

/** Read the technical fields from a settings form. Only call this for admins. */
export function channelChangesFromForm(form: { get(name: string): unknown }): ChannelChanges {
  const s = (k: string) => String(form.get(k) ?? "").trim();
  return {
    phoneNumberId: s("wa_phone_number_id") || null,
    token: s("wa_token") || undefined,
    disconnect: form.get("wa_disconnect") === "on",
    templatesApproved: form.get("wa_templates_approved") === "on",
  };
}

async function fetchDisplayNumber(phoneNumberId: string, accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${GRAPH}/${phoneNumberId}?fields=display_phone_number`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { display_phone_number?: string }).display_phone_number ?? null;
  } catch {
    return null;
  }
}

/**
 * Apply an admin's changes to a vendor's channels and log which fields changed.
 * Refuses anyone who isn't an admin. Returns the fields that changed.
 */
export async function updateChannels(
  vendorId: number,
  changes: ChannelChanges,
  actor: { id: number; email: string; admin: boolean },
  now = new Date(),
): Promise<string[]> {
  if (!actor.admin) throw new Error("Only Matchire admins can change channel settings.");
  const v = get<Vendor>("SELECT * FROM vendors WHERE id = ?", vendorId);
  if (!v) throw new Error("Vendor not found");

  const next = { id: v.wa_phone_number_id, token: v.wa_token, approved: !!v.wa_templates_approved, inbound: v.inbound_token };
  if (changes.disconnect) { next.id = null; next.token = null; }
  else {
    if (changes.phoneNumberId !== undefined) next.id = changes.phoneNumberId;
    if (changes.token) next.token = changes.token;
  }
  if (changes.templatesApproved !== undefined) next.approved = changes.templatesApproved;
  if (changes.rotateInbound) next.inbound = token(12).toLowerCase().replace(/[^a-z0-9]/g, "x");

  const changed: string[] = [];
  if (next.id !== v.wa_phone_number_id) changed.push("WhatsApp phone number ID");
  if (next.token !== v.wa_token) changed.push(next.token ? "WhatsApp access token" : "WhatsApp access token (removed)");
  if (next.approved !== !!v.wa_templates_approved) changed.push("Follow-up templates approved");
  if (next.inbound !== v.inbound_token) changed.push("Email forwarding address");
  if (!changed.length) return [];

  // The number Meta shows, so the vendor sees "Connected · +65 …" instead of an ID.
  const connectionChanged = next.id !== v.wa_phone_number_id || next.token !== v.wa_token;
  const display = !connectionChanged ? v.wa_display_number : next.id && next.token ? await fetchDisplayNumber(next.id, next.token) : null;

  tx(() => {
    run("UPDATE vendors SET wa_phone_number_id = ?, wa_token = ?, wa_templates_approved = ?, inbound_token = ?, wa_display_number = ? WHERE id = ?",
      next.id, next.token, next.approved ? 1 : 0, next.inbound, display, vendorId);
    for (const field of changed) {
      run("INSERT INTO channel_audit (vendor_id, actor_user_id, actor_email, field, created_at) VALUES (?, ?, ?, ?, ?)", vendorId, actor.id, actor.email, field, now.toISOString());
    }
  });
  return changed;
}

/** For vendors connected before the number was stored: look it up once. */
export async function ensureDisplayNumber(v: Vendor): Promise<Vendor> {
  if (!whatsappReady(v) || v.wa_display_number) return v;
  const n = await fetchDisplayNumber(v.wa_phone_number_id!, v.wa_token!);
  if (n) run("UPDATE vendors SET wa_display_number = ? WHERE id = ?", n, v.id);
  return { ...v, wa_display_number: n };
}

export const channelAudit = (vendorId: number) =>
  all<{ actor_email: string; field: string; created_at: string }>(
    "SELECT actor_email, field, created_at FROM channel_audit WHERE vendor_id = ? ORDER BY id DESC LIMIT 30", vendorId,
  );

// ---------- "Request setup" ----------

/**
 * Ask Matchire to set up a channel. Emails the admin at most once a day per
 * vendor and channel; demo accounts are only simulated.
 */
export async function requestChannelSetup(
  v: Vendor,
  user: { name: string; email: string },
  channel: SetupChannel,
  appUrl: string,
  now = new Date(),
): Promise<"sent" | "already_requested" | "demo" | string> {
  const last = lastRequest(v.id, channel);
  if (last && now.getTime() - new Date(last).getTime() < 86400_000) return "already_requested";
  if (v.is_demo) {
    console.log(`[demo] demo: not sent (setup request, vendor ${v.id}, ${channel})`);
    run("INSERT INTO setup_requests (vendor_id, channel, created_at) VALUES (?, ?, ?)", v.id, channel, now.toISOString());
    return "demo";
  }
  const label = channel === "whatsapp" ? "WhatsApp" : "Email forwarding";
  const error = await sendRawEmail({
    to: ALERT_TO(),
    replyTo: user.email,
    subject: `Setup request: ${label} for ${v.name}`,
    text: [
      `${v.name} asked for help setting up ${label}.`,
      "",
      `Name:      ${user.name}`,
      `Email:     ${user.email}`,
      `Business:  ${v.name}`,
      `Requested: ${formatDateTime(now.toISOString())} SGT`,
      "",
      `Set it up: ${appUrl}/app/admin/channels/${v.id}`,
    ].join("\n"),
  });
  if (error) return error;
  run("INSERT INTO setup_requests (vendor_id, channel, created_at) VALUES (?, ?, ?)", v.id, channel, now.toISOString());
  return "sent";
}

// ---------- Who counts as an admin ----------

/** The signed-in admin for a session token, or null for anyone else. Every admin page, route and action goes through this. */
export function adminForSession(sessionToken: string | undefined) {
  const u = userForSession(sessionToken);
  return u && isAdmin(u) ? u : null;
}
