import { currentUser } from "@/lib/auth";
import { isAdmin, listSignups, signupsCsv } from "@/lib/early-access";
import { sgToday } from "@/lib/dates";

export async function GET() {
  const user = await currentUser();
  if (!user || !isAdmin(user)) return new Response("Not found", { status: 404 });
  return new Response(signupsCsv(listSignups()), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="matchire-early-access-${sgToday()}.csv"`,
    },
  });
}
