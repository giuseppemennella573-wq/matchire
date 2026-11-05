import { after, type NextRequest } from "next/server";
import { notifySignup, signupFromForm } from "@/lib/early-access";

// Early-access sign-ups from the marketing page. Saved first, then the team is
// emailed after the response, so a slow or failing email never loses a sign-up.
export async function POST(req: NextRequest) {
  const f = await req.formData().catch(() => null);
  if (!f) return new Response("Bad request", { status: 400 });
  const id = signupFromForm(f);
  if (id === "bot") return Response.json({ ok: true });
  if (id === null) return new Response("Missing fields", { status: 400 });
  after(async () => {
    const error = await notifySignup(id);
    if (error) console.error(`Early-access alert for sign-up ${id} failed: ${error}`);
  });
  return Response.json({ ok: true });
}
