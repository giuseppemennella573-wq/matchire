import type { Vendor, VendorKind } from "./types.ts";
import { QUALIFY_FIELDS } from "./qualify.ts";

// The Settings page is split into tabs, and each tab saves only its own
// fields. This file is the single list of which column belongs to which tab,
// so saving Bookings can never touch, say, the business name.

export const SETTINGS_TABS = [
  { id: "business", label: "Business" },
  { id: "bookings", label: "Bookings" },
  { id: "channels", label: "Channels" },
  { id: "partners", label: "Partners & referrals" },
  { id: "ai", label: "AI & sending" },
  { id: "account", label: "Account" },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

/** Which tab an address opens: "#bookings", old anchors like "#password", or nothing (Business). */
export function tabFromHash(hash: string | null | undefined): SettingsTab {
  const h = (hash ?? "").replace(/^#/, "").toLowerCase();
  if (h === "password") return "account";
  return (SETTINGS_TABS.find((t) => t.id === h)?.id ?? "business") as SettingsTab;
}

type Form = { get(name: string): FormDataEntryValue | null };
type Columns = Partial<Record<keyof Vendor, string | number | null>>;

const str = (f: Form, k: string) => String(f.get(k) ?? "").trim();
const num = (f: Form, k: string) => {
  const s = str(f, k);
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const atLeast = (f: Form, k: string, fallback: number, min = 0) => Math.max(min, num(f, k) ?? fallback);

/**
 * The vendor columns one tab's Save may write, read from that tab's form.
 * Channel connections and template approval aren't here: only admins change
 * those, through updateChannels().
 */
export function settingsUpdate(tab: SettingsTab, form: Form, v: Vendor): Columns {
  switch (tab) {
    case "business":
      return {
        name: str(form, "name") || v.name,
        kind: (str(form, "kind") || v.kind) as VendorKind,
        tone: str(form, "tone") || v.tone,
        signoff: str(form, "signoff"),
        notes: str(form, "notes"),
      };
    case "bookings":
      return {
        jobs_per_day: atLeast(form, "jobs_per_day", 1, 1),
        hold_hours: atLeast(form, "hold_hours", 48, 1),
        followup_days: atLeast(form, "followup_days", 2, 0.5),
        min_spend: atLeast(form, "min_spend", 0),
        offpeak_discount: Math.min(90, atLeast(form, "offpeak_discount", 0)),
        capacity: num(form, "capacity"),
        deposit_note: str(form, "deposit_note"),
      };
    case "partners":
      return {
        bundle_suggestions: form.get("bundle_suggestions") === "on" ? 1 : 0,
        share_from_price: form.get("share_from_price") === "on" ? 1 : 0,
        referral_fee_pct: Math.min(50, atLeast(form, "referral_fee_pct", 10)),
      };
    case "ai":
      return {
        auto_send: !v.is_demo && form.get("auto_send") === "on" ? 1 : 0, // locked off on demo accounts
        qualify_fields: QUALIFY_FIELDS.filter((f) => form.get(`qualify_${f.id}`) === "on").map((f) => f.id).join(","),
        pricing_mode: form.get("pricing_mode") === "brief" ? "brief" : "quote",
        brief_hours: Math.min(168, atLeast(form, "brief_hours", 24, 1)),
        brief_questions: str(form, "brief_questions").split("\n").map((q) => q.trim()).filter(Boolean).slice(0, 10).join("\n"),
      };
    default:
      return {}; // channels and account have their own actions
  }
}

const GENERIC =
  "Example: We need a 2m x 2m space near a power socket. Setup takes 30 min before start time. 30% deposit secures the date. Travel outside central +S$50. We don't do outdoor events.";

/** An example for "What Matchire should know about your business", by category. */
export function notesPlaceholder(kind: VendorKind): string {
  switch (kind) {
    case "photobooth":
      return "Example: We need a 2m x 3m space and one power socket. Setup takes 45 min. 30% deposit secures the date. Travel to Sentosa +S$80. No events past midnight.";
    case "caterer":
      return "Example: Minimum 50 pax. Halal-certified kitchen. Final numbers 7 days before. Buffet setup 1h before serving. Delivery outside central +S$50.";
    case "venue":
      return "Example: Max 200 standing, 120 seated. Outside vendors allowed with S$300 fee. Music off by 11pm. 50% deposit to confirm.";
    default:
      return GENERIC;
  }
}
