import { currentAdmin } from "@/lib/auth";
import { listSignups, signupsCsv } from "@/lib/early-access";
import { sgToday } from "@/lib/dates";

export async function GET() {
  if (!(await currentAdmin())) return new Response("Not found", { status: 404 });
  return new Response(signupsCsv(listSignups()), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="matchire-early-access-${sgToday()}.csv"`,
    },
  });
}
