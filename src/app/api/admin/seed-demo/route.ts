import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { seedDemo } from "@/lib/demo";

// Reset the demo workspace from Render's Shell (the production image has no
// TypeScript scripts, so `npm run seed:demo` can't run there). Needs CRON_SECRET.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    return Response.json({ ok: true, ...(await seedDemo()) });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
