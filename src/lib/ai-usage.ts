import { all, run } from "./db.ts";

// What each Claude call costs. One row per call: tokens, model and purpose,
// never message content. Recording must never break a reply, so every write
// is wrapped and failures are swallowed.

export type AiPurpose = "extract" | "draft" | "import";

/**
 * USD per million tokens. Anthropic first-party API list prices, checked
 * 2026-11-02 against the claude-api skill's model table (cached 2026-10-06).
 * Cache writes are the 5-minute TTL rate (1.25x input); cache reads per the
 * same reference. Re-check when prices change or a model is added.
 */
export const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

export interface UsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Cost in USD, or null for a model we have no price for. */
export function costUsd(model: string, u: UsageTokens): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (
    (u.input_tokens * p.input + u.output_tokens * p.output + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite + (u.cache_read_input_tokens ?? 0) * p.cacheRead) /
    1_000_000
  );
}

export interface UsageContext { vendorId?: number | null; enquiryId?: number | null }

export function recordAiUsage(row: { purpose: AiPurpose; model: string; ctx?: UsageContext; usage?: UsageTokens | null; error?: string | null; now?: Date }) {
  try {
    const u = row.usage;
    run(
      `INSERT INTO ai_usage (vendor_id, enquiry_id, purpose, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_usd, ok, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.ctx?.vendorId ?? null, row.ctx?.enquiryId ?? null, row.purpose, row.model,
      u?.input_tokens ?? 0, u?.output_tokens ?? 0, u?.cache_creation_input_tokens ?? 0, u?.cache_read_input_tokens ?? 0,
      u ? costUsd(row.model, u) : 0, row.error ? 0 : 1, (row.now ?? new Date()).toISOString(),
    );
  } catch (e) {
    console.warn(`[ai-usage] not recorded: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface UsageLine { calls: number; errors: number; enquiries: number; input: number; output: number; cacheWrite: number; cacheRead: number; cost: number }
export interface UsageSummary {
  total: UsageLine;
  /** Cost per enquiry that had at least one extract or draft call. */
  perEnquiry: number | null;
  demo: UsageLine;
  byVendor: (UsageLine & { vendorId: number | null; name: string })[];
  byPurpose: (UsageLine & { purpose: string })[];
  byModel: (UsageLine & { model: string })[];
  unpricedCalls: number;
}

const LINE = `COUNT(*) calls, SUM(1 - ok) errors, COUNT(DISTINCT u.enquiry_id) enquiries, SUM(input_tokens) input, SUM(output_tokens) output,
  SUM(cache_write_tokens) cacheWrite, SUM(cache_read_tokens) cacheRead, COALESCE(SUM(cost_usd), 0) cost`;
const EMPTY: UsageLine = { calls: 0, errors: 0, enquiries: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
const line = <T,>(r: T | undefined) => ({ ...EMPTY, ...Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, v ?? 0])) }) as UsageLine & T;

/** Usage since a date. Demo accounts are left out of the totals and shown on their own line. */
export function usageSummary(since: Date): UsageSummary {
  const from = since.toISOString();
  const base = "FROM ai_usage u LEFT JOIN vendors v ON v.id = u.vendor_id WHERE u.created_at >= ?";
  const real = `${base} AND COALESCE(v.is_demo, 0) = 0`;
  const total = line(all<UsageLine>(`SELECT ${LINE} ${real}`, from)[0]);
  const demo = line(all<UsageLine>(`SELECT ${LINE} ${base} AND v.is_demo = 1`, from)[0]);
  return {
    total,
    perEnquiry: total.enquiries ? total.cost / total.enquiries : null,
    demo,
    byVendor: all<UsageLine & { vendorId: number | null; name: string | null }>(`SELECT u.vendor_id vendorId, v.name name, ${LINE} ${real} GROUP BY u.vendor_id ORDER BY cost DESC`, from)
      .map((r) => ({ ...line(r), vendorId: r.vendorId, name: r.name ?? "(account deleted or none)" })),
    byPurpose: all<UsageLine & { purpose: string }>(`SELECT purpose, ${LINE} ${real} GROUP BY purpose ORDER BY cost DESC`, from).map((r) => ({ ...line(r), purpose: r.purpose })),
    byModel: all<UsageLine & { model: string }>(`SELECT model, ${LINE} ${real} GROUP BY model ORDER BY cost DESC`, from).map((r) => ({ ...line(r), model: r.model })),
    unpricedCalls: all<{ n: number }>(`SELECT COUNT(*) n ${real} AND u.cost_usd IS NULL`, from)[0]?.n ?? 0,
  };
}
