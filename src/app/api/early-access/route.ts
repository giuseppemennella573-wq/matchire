import { after, type NextRequest } from "next/server";
import { addSignup, notifySignup } from "@/lib/early-access";

// Early-access sign-ups from the marketing page. Saved first, then the team is
// emailed after the response, so a slow or failing email never loses a sign-up.
export async function POST(req: NextRequest) {
  const f = await req.formData().catch(() => null);
  if (!f) return new Response("Bad request", { status: 400 });
  const s = (k: string) => String(f.get(k) ?? "").trim().slice(0, 300) || null;
  if (s("bot-field")) return Response.json({ ok: true });
  if (!s("email") || !s("name")) return new Response("Missing fields", { status: 400 });
  const id = addSignup({
    name: s("name"), business: s("business"), vendor_type: s("vendor_type"),
    enquiries_per_week: s("enquiries_per_week"), email: s("email"), whatsapp: s("whatsapp"),
  });
  after(async () => {
    const error = await notifySignup(id);
    if (error) console.error(`Early-access alert for sign-up ${id} failed: ${error}`);
  });
  return Response.json({ ok: true });
}
