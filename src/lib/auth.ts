import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { userForSession } from "./accounts.ts";
import { getVendor } from "./engine.ts";

export const SESSION_COOKIE = "matchire_session";

export async function currentUser() {
  const jar = await cookies();
  return userForSession(jar.get(SESSION_COOKIE)?.value);
}

/** The signed-in user and their vendor, or a redirect to the login page. */
export async function requireVendor() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const vendor = getVendor(user.vendor_id);
  if (!vendor) redirect("/login");
  return { user, vendor };
}

export async function setSessionCookie(token: string, expires: Date) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires });
}
