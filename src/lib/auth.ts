import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { userForSession } from "./accounts.ts";
import { getVendor } from "./engine.ts";
import { adminForSession } from "./channel-settings.ts";
import { activeSupport, logSupportPage, READ_ONLY_MESSAGE, SUPPORT_COOKIE, vendorOwner, type SupportAccess } from "./support.ts";

export const SESSION_COOKIE = "matchire_session";

export async function currentUser() {
  const jar = await cookies();
  return userForSession(jar.get(SESSION_COOKIE)?.value);
}

/** The admin's live Support view session, if they're in one. */
export async function currentSupport(user?: { id: number; email: string } | null): Promise<SupportAccess | null> {
  const jar = await cookies();
  const token = jar.get(SUPPORT_COOKIE)?.value;
  if (!token) return null;
  return activeSupport(token, user === undefined ? await currentUser() : user);
}

/**
 * The signed-in user and their vendor, or a redirect to the login page. For pages:
 * in Support view this is the vendor being supported (and the page is logged).
 * Server actions use requireVendorForAction instead.
 */
export async function requireVendor() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const support = await currentSupport(user);
  if (support) {
    const vendor = getVendor(support.vendor_id);
    const owner = vendorOwner(support.vendor_id);
    if (vendor && owner) {
      const h = await headers();
      const path = h.get("x-matchire-path");
      if (path && !h.get("next-action") && !h.get("next-router-prefetch")) logSupportPage(support.id, path);
      return { user: { ...user, ...owner }, vendor, support };
    }
  }
  const vendor = getVendor(user.vendor_id);
  if (!vendor) redirect("/login");
  return { user, vendor, support: null };
}

/** Like requireVendor, for anything that changes data: refused in Support view, which is read-only. */
export async function requireVendorForAction() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (await currentSupport(user)) {
    const ref = (await headers()).get("referer");
    let back = "/app";
    try { const u = new URL(ref ?? ""); if (u.pathname.startsWith("/app")) back = u.pathname; } catch { /* no referer */ }
    redirect(`${back}?readonly=1`);
  }
  const vendor = getVendor(user.vendor_id);
  if (!vendor) redirect("/login");
  return { user, vendor };
}

export { READ_ONLY_MESSAGE };

export async function setSessionCookie(token: string, expires: Date) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires });
}

/** The signed-in Matchire admin, or null. Use for routes, which answer 404 to everyone else. */
export async function currentAdmin() {
  const jar = await cookies();
  return adminForSession(jar.get(SESSION_COOKIE)?.value);
}

/** The signed-in Matchire admin and their vendor; anyone else is sent back to /app. */
export async function requireAdmin() {
  const admin = await currentAdmin();
  if (!admin) redirect("/app");
  const vendor = getVendor(admin.vendor_id);
  if (!vendor) redirect("/login");
  return { user: admin, vendor };
}
