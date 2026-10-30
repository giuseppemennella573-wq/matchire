export type VendorKind = "photobooth" | "venue" | "caterer" | "av" | "decor" | "emcee" | "photography" | "other";

export const VENDOR_KINDS: { value: VendorKind; label: string }[] = [
  { value: "photobooth", label: "Photobooth" },
  { value: "venue", label: "Venue" },
  { value: "caterer", label: "Catering" },
  { value: "av", label: "AV & sound" },
  { value: "decor", label: "Décor / florist" },
  { value: "emcee", label: "Emcee / entertainment" },
  { value: "photography", label: "Photography / video" },
  { value: "other", label: "Other" },
];

export interface Vendor {
  id: number;
  name: string;
  kind: VendorKind;
  slug: string;
  tone: string;
  signoff: string;
  capacity: number | null;
  jobs_per_day: number;
  min_spend: number;
  offpeak_discount: number;
  auto_send: number;
  hold_hours: number;
  followup_days: number;
  bundle_suggestions: number;
  referral_fee_pct: number;
  /** Partners may see (and mention to their clients) this vendor's lowest live package price. Off by default. */
  share_from_price: number;
  /** The connected WhatsApp number as Meta shows it ("+65 9647 2283"), fetched when the connection is saved. */
  wa_display_number: string | null;
  /** Demo account for showing prospects: nothing it does is ever really sent. */
  is_demo: number;
  deposit_note: string;
  notes: string;
  wa_phone_number_id: string | null;
  wa_token: string | null;
  /** The vendor has quote_nudge and quote_last_call approved in their WhatsApp Business account. */
  wa_templates_approved: number;
  inbound_token: string;
  created_at: string;
}

export interface User {
  id: number;
  vendor_id: number;
  email: string;
  name: string;
}

export type Pricing = "flat" | "per_hour" | "per_pax";

export interface Item {
  id: number;
  vendor_id: number;
  kind: "package" | "addon";
  name: string;
  description: string;
  pricing: Pricing;
  price: number;
  included_hours: number | null;
  extra_hour_price: number | null;
  min_pax: number | null;
  max_pax: number | null;
  active: number;
  sort: number;
}

export type Channel = "whatsapp" | "email" | "web" | "instagram" | "manual" | "referral";

export const CHANNEL_LABEL: Record<Channel, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  web: "Web form",
  instagram: "Instagram",
  manual: "Manual",
  referral: "Partner referral",
};

export type EnquiryStatus =
  | "new"
  | "awaiting_info"
  | "quoted"
  | "won"
  | "lost"
  | "referred"
  | "expired";

export const STATUS_LABEL: Record<EnquiryStatus, string> = {
  new: "New",
  awaiting_info: "Awaiting info",
  quoted: "Quoted",
  won: "Booked",
  lost: "Lost",
  referred: "Referred",
  expired: "Expired",
};

// Pipeline stage lives in `status`. Whether a drafted reply is waiting for the
// owner is separate: an enquiry is "needs approval" while it has a draft message.
export const OPEN_STATUSES: EnquiryStatus[] = ["new", "awaiting_info", "quoted"];

export type Slot = "morning" | "afternoon" | "evening" | "full_day";
export type EventType = "wedding" | "birthday" | "corporate" | "launch" | "private_party" | "other";
export type Intent = "new_enquiry" | "accepts_quote" | "question" | "declines" | "other";

/** What Matchire understood from the conversation so far. */
export interface Details {
  contact_name: string | null;
  event_date: string | null; // YYYY-MM-DD, Singapore time
  date_text: string | null;
  date_is_approximate: boolean;
  slot: Slot | null;
  start_time: string | null;
  hours: number | null;
  pax: number | null;
  budget: number | null;
  event_type: EventType | null;
  location: string | null;
  package_id: number | null;
  addon_ids: number[];
  needs: string[];
  questions: string[];
  needs_owner: boolean;
  owner_reason: string | null;
  intent: Intent;
  summary: string | null;
}

export const EMPTY_DETAILS: Details = {
  contact_name: null,
  event_date: null,
  date_text: null,
  date_is_approximate: false,
  slot: null,
  start_time: null,
  hours: null,
  pax: null,
  budget: null,
  event_type: null,
  location: null,
  package_id: null,
  addon_ids: [],
  needs: [],
  questions: [],
  needs_owner: false,
  owner_reason: null,
  intent: "new_enquiry",
  summary: null,
};

export interface QuoteLine {
  label: string;
  amount: number;
  note?: string;
  full?: number; // pre-discount amount, when a discount applies
}

export interface Quote {
  package_id: number | null;
  lines: QuoteLine[];
  total: number;
  offpeak: boolean;
  issues: string[];
}

export interface Enquiry {
  id: number;
  vendor_id: number;
  channel: Channel;
  contact_name: string | null;
  contact_handle: string | null;
  contact_email: string | null;
  status: EnquiryStatus;
  lead: "hot" | "warm" | "cold" | null;
  details: string;
  quote: string | null;
  owner_reason: string | null;
  event_date: string | null;
  first_response_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  followup_stage: number;
  next_followup_at: string | null;
  won_value: number | null;
  referred_from: number | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  enquiry_id: number;
  direction: "in" | "out" | "note";
  body: string;
  status: "draft" | "sent" | "manual" | "failed" | "discarded";
  purpose: string | null;
  error: string | null;
  /** JSON WaTemplate when this reply goes out as a WhatsApp template. */
  template: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface Hold {
  id: number;
  vendor_id: number;
  enquiry_id: number | null;
  date: string;
  kind: "hold" | "booking" | "block";
  status: "active" | "released" | "expired";
  note: string;
  expires_at: string | null;
  created_at: string;
}

/** All another business ever learns about a partner's prices: at most one "from" price, and only if the partner opted in. */
export interface PartnerView {
  name: string;
  category: string;
  from_price: string | null;
}
