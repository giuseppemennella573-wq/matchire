import type { NextRequest } from "next/server";
import { tick } from "@/lib/engine";

// Follow-ups and hold expiry. Runs in-process every minute (see instrumentation.ts);
// this endpoint lets an external scheduler drive it on hosts that sleep.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? req.nextUrl.searchParams.get("key");
  if (!secret || given !== secret) return new Response("Unauthorized", { status: 401 });
  return Response.json(await tick());
}
