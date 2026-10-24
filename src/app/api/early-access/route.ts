import type { NextRequest } from "next/server";
import { run } from "@/lib/db";

// Early-access sign-ups from the marketing page.
export async function POST(req: NextRequest) {
  const f = await req.formData().catch(() => null);
  if (!f) return new Response("Bad request", { status: 400 });
  const s = (k: string) => String(f.get(k) ?? "").trim().slice(0, 300);
  if (s("bot-field")) return Response.json({ ok: true });
  if (!s("email") || !s("name")) return new Response("Missing fields", { status: 400 });
  run("INSERT INTO early_access (name, business, vendor_type, enquiries_per_week, email, whatsapp) VALUES (?, ?, ?, ?, ?, ?)",
    s("name"), s("business"), s("vendor_type"), s("enquiries_per_week"), s("email"), s("whatsapp"));
  return Response.json({ ok: true });
}
