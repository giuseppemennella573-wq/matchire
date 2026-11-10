import { LLMS_TXT } from "../../lib/llms-txt.ts";

// Served the same on matchire.ai and app.matchire.ai.
export const dynamic = "force-static";

export function GET() {
  return new Response(LLMS_TXT, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
