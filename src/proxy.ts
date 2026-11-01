import { NextResponse, type NextRequest } from "next/server";

// Tells server components which page is being rendered, so Support view can log
// the pages an admin opens (paths only, never the query or content).
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-matchire-path", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/app", "/app/:path*"] };
