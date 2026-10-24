import type { Item, Quote, QuoteLine, Vendor } from "./types.ts";
import { isOffPeak } from "./dates.ts";

// The quote engine. Prices come only from the vendor's own price list and
// rules; the language model can choose *which* package and add-ons fit an
// enquiry, but every number on a quote is computed here.

export interface QuoteInput {
  vendor: Pick<Vendor, "min_spend" | "offpeak_discount" | "capacity">;
  pkg: Item | null;
  addons: Item[];
  hours: number | null;
  pax: number | null;
  date: string | null;
  slot: string | null;
}

const round = (n: number) => Math.round(n * 100) / 100;

export function fmtMoney(n: number): string {
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  return "SGD " + n.toLocaleString("en-SG", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

function hoursFor(pkg: Item, requested: number | null): number {
  const base = pkg.included_hours ?? 0;
  if (requested == null || requested <= 0) return base || 1;
  return Math.max(requested, base || 0);
}

function priceItem(item: Item, hours: number | null, pax: number | null, issues: string[]): QuoteLine[] {
  const lines: QuoteLine[] = [];
  if (item.pricing === "flat") {
    const inc = item.included_hours;
    lines.push({ label: inc ? `${item.name} · ${inc}h` : item.name, amount: item.price });
    if (inc && hours && hours > inc) {
      const extra = hours - inc;
      if (item.extra_hour_price != null) {
        lines.push({ label: `Extra ${extra}h`, amount: extra * item.extra_hour_price });
      } else {
        issues.push(`${item.name} includes ${inc}h but ${hours}h were requested, and no extra-hour rate is set.`);
      }
    }
  } else if (item.pricing === "per_hour") {
    const h = item.kind === "package" ? hoursFor(item, hours) : hours ?? item.included_hours ?? 1;
    lines.push({ label: `${item.name} · ${h}h × ${fmtMoney(item.price)}`, amount: h * item.price });
  } else {
    let n = pax ?? item.min_pax ?? 0;
    if (!pax) issues.push(`Headcount unknown for ${item.name}; quoted at the minimum of ${n}.`);
    if (item.min_pax && n < item.min_pax) {
      issues.push(`${n} pax is below the ${item.min_pax} pax minimum for ${item.name}; charged at the minimum.`);
      n = item.min_pax;
    }
    lines.push({ label: `${item.name} · ${n} pax × ${fmtMoney(item.price)}`, amount: n * item.price });
  }
  if (item.max_pax && pax && pax > item.max_pax) issues.push(`${pax} pax is above the ${item.max_pax} pax limit for ${item.name}.`);
  return lines;
}

export function buildQuote(input: QuoteInput): Quote {
  const { vendor, pkg, addons, pax, date, slot } = input;
  const issues: string[] = [];
  if (!pkg) return { package_id: null, lines: [], total: 0, offpeak: false, issues: ["No package matches this enquiry."] };

  const hours = pkg.pricing === "per_pax" ? input.hours : hoursFor(pkg, input.hours);
  const offpeak = vendor.offpeak_discount > 0 && isOffPeak(date, slot);

  const lines = priceItem(pkg, hours, pax, issues);
  if (offpeak) {
    // The discount applies to the package itself, never to add-ons or fees.
    const pct = vendor.offpeak_discount / 100;
    for (const l of lines) {
      l.full = l.amount;
      l.amount = round(l.amount * (1 - pct));
    }
    lines[0].note = `${vendor.offpeak_discount}% weekday daytime rate`;
  }
  for (const a of addons) lines.push(...priceItem(a, hours, pax, issues));

  let total = round(lines.reduce((s, l) => s + l.amount, 0));
  if (vendor.min_spend > 0 && total < vendor.min_spend) {
    lines.push({ label: "Minimum spend top-up", amount: round(vendor.min_spend - total) });
    total = vendor.min_spend;
  }
  if (vendor.capacity && pax && pax > vendor.capacity) issues.push(`${pax} guests exceeds the ${vendor.capacity} capacity.`);

  return { package_id: pkg.id, lines: lines.map((l) => ({ ...l, amount: round(l.amount) })), total, offpeak, issues };
}

/** Every amount a reply is allowed to mention: line items, totals and package prices. */
export function allowedAmounts(quote: Quote | null, items: Item[], extra: number[] = []): Set<number> {
  const s = new Set<number>();
  const add = (n: number | null | undefined) => n != null && s.add(round(n));
  if (quote) {
    add(quote.total);
    quote.lines.forEach((l) => { add(l.amount); add(l.full); });
  }
  items.forEach((i) => { add(i.price); add(i.extra_hour_price); });
  extra.forEach(add);
  return s;
}

/**
 * Find money amounts in a drafted reply that aren't on the price list or quote.
 * This is the guardrail behind "never invents a price".
 */
export function unknownAmounts(text: string, allowed: Set<number>): number[] {
  const found: number[] = [];
  const re = /(?:sgd|s\$|\$)\s?(\d[\d,]*(?:\.\d{1,2})?)\s?(k\b)?|(\d[\d,]*(?:\.\d{1,2})?)\s?(?:sgd|dollars)\b/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[1] ?? m[3];
    if (!raw) continue;
    const n = parseFloat(raw.replace(/,/g, "")) * (m[2] ? 1000 : 1);
    if (!allowed.has(round(n))) found.push(n);
  }
  return found;
}
