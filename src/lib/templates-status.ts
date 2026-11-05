import { get, run } from "./db.ts";
import type { Vendor } from "./types.ts";

// Are the WhatsApp follow-up templates (quote_nudge, quote_last_call) approved?
// Templates belong to a WhatsApp Business Account (WABA). For numbers under
// Matchire's own WABA (WHATSAPP_WABA_ID), the answer comes from Meta, cached
// for an hour. Other numbers keep the admin's manual tick.

const GRAPH = "https://graph.facebook.com/v21.0";
export const FOLLOWUP_TEMPLATES = ["quote_nudge", "quote_last_call"] as const;
const CACHE_KEY = "waba_templates";
const TTL_MS = 3600_000;

export type TemplateState = "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "DISABLED" | "MISSING" | string;
export interface TemplateStatus {
  /** "meta": read from Meta (Matchire's WABA); "manual": the admin's tick. */
  source: "meta" | "manual";
  approved: boolean;
  /** Per template, from Meta. */
  states?: Record<string, TemplateState>;
  checkedAt?: string;
  error?: string;
}

export const matchireWaba = () => process.env.WHATSAPP_WABA_ID?.trim() || null;
export const underMatchireWaba = (v: Pick<Vendor, "wa_matchire_waba">) => !!matchireWaba() && !!v.wa_matchire_waba;

interface Cached { states: Record<string, TemplateState>; checkedAt: string; error?: string }
function readCache(): Cached | null {
  const r = get<{ value: string }>("SELECT value FROM app_status WHERE key = ?", CACHE_KEY);
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
}

const fromStates = (states: Record<string, TemplateState>) => FOLLOWUP_TEMPLATES.every((n) => states[n] === "APPROVED");

/** The status to act on right now (no network): Meta's cached answer for the Matchire WABA, else the manual tick. */
export function templateStatus(v: Pick<Vendor, "wa_templates_approved" | "wa_matchire_waba">): TemplateStatus {
  if (!underMatchireWaba(v)) return { source: "manual", approved: !!v.wa_templates_approved };
  const c = readCache();
  if (!c || c.error) return { source: "meta", approved: !!v.wa_templates_approved, states: c?.states, checkedAt: c?.checkedAt, error: c?.error ?? "Not checked yet" };
  return { source: "meta", approved: fromStates(c.states), states: c.states, checkedAt: c.checkedAt };
}

/** Asks Meta for the templates' status (at most once an hour), using the vendor's token or WHATSAPP_SYSTEM_TOKEN. */
export async function refreshTemplateStatus(v: Pick<Vendor, "wa_templates_approved" | "wa_matchire_waba" | "wa_token">, now = new Date(), fetcher: typeof fetch = fetch): Promise<TemplateStatus> {
  const waba = matchireWaba();
  if (!underMatchireWaba(v) || !waba) return templateStatus(v);
  const c = readCache();
  if (c && !c.error && now.getTime() - Date.parse(c.checkedAt) < TTL_MS) return templateStatus(v);
  const token = process.env.WHATSAPP_SYSTEM_TOKEN || v.wa_token;
  let value: Cached;
  if (!token) value = { states: c?.states ?? {}, checkedAt: now.toISOString(), error: "No WhatsApp token to check with" };
  else {
    try {
      const res = await fetcher(`${GRAPH}/${encodeURIComponent(waba)}/message_templates?fields=name,status,language&limit=200`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Meta answered ${res.status}`);
      const body = (await res.json()) as { data?: { name: string; status: string; language?: string }[] };
      const states: Record<string, TemplateState> = {};
      for (const n of FOLLOWUP_TEMPLATES) {
        const rows = (body.data ?? []).filter((t) => t.name === n);
        states[n] = (rows.find((t) => (t.language ?? "").startsWith("en")) ?? rows[0])?.status ?? "MISSING";
      }
      value = { states, checkedAt: now.toISOString() };
    } catch (e) {
      // Never log the token; the message is Meta's status or a network error.
      value = { states: c?.states ?? {}, checkedAt: now.toISOString(), error: e instanceof Error ? e.message : String(e) };
    }
  }
  run(
    "INSERT INTO app_status (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    CACHE_KEY, JSON.stringify(value), now.toISOString(),
  );
  return templateStatus(v);
}

/** "Approved", "Waiting for Meta's approval", … for the Channels page. */
export function describeStatus(s: TemplateStatus): string {
  if (s.source === "manual") return s.approved ? "approved" : "not approved yet";
  if (s.error && !s.states) return `couldn't check with Meta (${s.error})`;
  if (s.approved) return "approved by Meta";
  const states = Object.values(s.states ?? {});
  if (states.some((x) => x === "REJECTED")) return "rejected by Meta: we'll fix and resubmit them";
  if (states.some((x) => x === "MISSING")) return "not submitted to Meta yet";
  return "waiting for Meta's approval";
}
