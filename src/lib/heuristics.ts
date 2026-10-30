import { EMPTY_DETAILS, type Details, type EventType, type Intent, type Item, type Slot } from "./types.ts";
import { formatDate, resolveDate, sgToday } from "./dates.ts";

// Rules-based enquiry reader. Matchire uses it when no Claude API key is
// configured, and as a safety net if a model call fails. It handles the
// common shapes of Singapore event enquiries well enough to quote from.

const STOP = new Set(["the", "and", "for", "with", "package", "set", "hire", "per", "pax", "hour", "hours", "rental", "service"]);

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
}

/** How well a package's included hours cover the request: 0 is exact, bigger is worse, too short is worst. */
function hoursFit(p: Item, hours: number | null): number {
  if (hours == null || p.included_hours == null) return 0;
  return p.included_hours >= hours ? p.included_hours - hours : 100 + hours - p.included_hours;
}

export function matchPackage(text: string, items: Item[], hours: number | null = null): Item | null {
  const pkgs = items.filter((i) => i.kind === "package" && i.active);
  if (!pkgs.length) return null;
  const low = text.toLowerCase();
  // Words every package shares ("booth" for a photobooth) can't tell them apart.
  const vocab = pkgs.map((p) => new Set(words(p.name + " " + p.description)));
  const shared = new Set([...vocab[0]].filter((w) => vocab.every((v) => v.has(w))));
  let best: Item | null = null;
  let bestScore = 0;
  pkgs.forEach((p, i) => {
    const name = new Set(words(p.name));
    let score = 0;
    for (const w of vocab[i]) {
      if (shared.has(w) || !new RegExp(`\\b${w.replace(/[^a-z0-9]/g, "")}`).test(low)) continue;
      score += name.has(w) ? 2 : 1;
    }
    // Equal word matches (e.g. "Classic Booth 2h / 3h / 4h") are settled by which one fits the hours asked for.
    if (score > bestScore || (score === bestScore && best && hoursFit(p, hours) < hoursFit(best, hours))) { best = p; bestScore = score; }
  });
  if (best) return best;
  return [...pkgs].sort((a, b) => hoursFit(a, hours) - hoursFit(b, hours))[0];
}

export function matchAddons(text: string, items: Item[]): Item[] {
  const low = text.toLowerCase();
  return items.filter((i) => i.kind === "addon" && i.active && words(i.name).some((w) => new RegExp(`\\b${w}`).test(low)));
}

export function parseEnquiry(text: string, items: Item[], today: string = sgToday()): Details {
  const low = text.toLowerCase();
  const d: Details = { ...EMPTY_DETAILS, addon_ids: [], needs: [], questions: [] };

  const pax = [...low.matchAll(/(\d{1,4})\s*(?:pax|people|persons|ppl|guests|kids|adults|pp|attendees|staff)\b/g)].map((m) => +m[1]);
  d.pax = pax.length ? Math.max(...pax) : null;

  const hm = low.match(/(\d{1,2}(?:\.5)?)\s*(?:h|hr|hrs|hour|hours)\b/);
  d.hours = hm ? +hm[1] : null;

  const bm = low.match(/budget[^\d$]{0,15}\$?\s?(\d[\d,]*(?:\.\d+)?)\s?(k)?\b/) || low.match(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k)?\b/);
  d.budget = bm ? parseFloat(bm[1].replace(/,/g, "")) * (bm[2] ? 1000 : 1) : null;

  const date = resolveDate(text, today);
  d.event_date = date.date;
  d.date_text = date.text;
  d.date_is_approximate = date.approximate;

  const slot: Slot | null = /full day|whole day|all day/.test(low) ? "full_day"
    : /morning|breakfast|\bam\b/.test(low) ? "morning"
    : /afternoon|lunch|tea/.test(low) ? "afternoon"
    : /evening|night|dinner|\bpm\b/.test(low) ? "evening" : null;
  d.slot = slot;
  const tm = low.match(/\b(\d{1,2}(?::\d{2})?\s?(?:am|pm))\b/);
  d.start_time = tm ? tm[1] : null;

  const type: EventType | null = /wedding|solemni|\brom\b|bride|groom/.test(low) ? "wedding"
    : /launch/.test(low) ? "launch"
    : /birthday|21st|\d0th|bday|party|celebration/.test(low) ? "birthday"
    : /offsite|town hall|corporate|office|company|d&d|dinner and dance|family day|team|conference|seminar/.test(low) ? "corporate" : null;
  d.event_type = type;

  d.location = findLocation(text);

  const needs: [string, string][] = [["halal", "Halal"], ["vegetarian", "Vegetarian"], ["vegan", "Vegan"], ["projector", "Projector"], ["360", "360 booth"], ["frame", "Custom print frame"], ["logo", "Branding"], ["led", "LED wall"], ["outside catering", "Outside catering"], ["min spend", "Minimum spend"], ["parking", "Parking"], ["mic", "Microphones"]];
  for (const [k, label] of needs) if (low.includes(k)) d.needs.push(label);

  for (const q of text.match(/[^.!?\n]+\?/g) ?? []) if (q.trim().length > 3) d.questions.push(q.trim());

  const pkg = matchPackage(text, items, d.hours);
  d.package_id = pkg?.id ?? null;
  d.addon_ids = matchAddons(text, items).map((a) => a.id);

  const nm = text.match(/\b(?:i'?m|i am|this is|my name is|name'?s)\s+([A-Z][a-z]+)/);
  d.contact_name = nm ? nm[1] : null;

  d.intent = detectIntent(low);
  const label = type ? type[0].toUpperCase() + type.slice(1).replace("_", " ") : null;
  d.summary = [label, d.pax ? `${d.pax} pax` : null, d.event_date ? formatDate(d.event_date) : null].filter(Boolean).join(" · ") || null;
  return d;
}

const NOT_PLACES = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|singapore)\b/i;

/** "at Raffles Hotel", "in Marina Bay", "@ The Loft": a capitalised place name after at / in / @. */
export function findLocation(text: string): string | null {
  for (const m of text.matchAll(/(?:\b[Aa]t|\b[Ii]n|@)\s+((?:the\s+)?[A-Z][\w&'.-]*(?:\s+(?:[A-Z][\w&'.-]*|of|de))*)/g)) {
    const place = m[1].replace(/\s+(of|de)$/, "").trim();
    if (!NOT_PLACES.test(place)) return place;
  }
  return null;
}

export function detectIntent(low: string): Intent {
  if (/\b(not|no longer|won'?t|cancel|found another|went with|too expensive|pass)\b/.test(low) && !/\?/.test(low)) return "declines";
  if (/\b(go ahead|confirm|book it|let'?s do|sounds good|ok(ay)? let'?s|deal|how (do|can) (i|we) pay|deposit|yes please)\b/.test(low)) return "accepts_quote";
  if (/\?/.test(low)) return "question";
  return "other";
}
