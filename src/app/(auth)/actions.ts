"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAccount, createSession, deleteSession, login } from "@/lib/accounts";
import { SESSION_COOKIE, setSessionCookie } from "@/lib/auth";
import type { VendorKind } from "@/lib/types";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function loginAction(form: FormData) {
  const userId = login(str(form, "email"), String(form.get("password") ?? ""));
  if (!userId) redirect(`/login?error=${encodeURIComponent("That email and password don't match.")}`);
  const s = createSession(userId);
  await setSessionCookie(s.token, s.expires);
  redirect("/app");
}

export async function signupAction(form: FormData) {
  let userId: number;
  try {
    ({ userId } = createAccount({
      email: str(form, "email"),
      password: String(form.get("password") ?? ""),
      name: str(form, "name"),
      business: str(form, "business"),
      kind: (str(form, "kind") || "other") as VendorKind,
      samplePrices: form.get("sample") === "on",
    }));
  } catch (e) {
    redirect(`/signup?error=${encodeURIComponent(e instanceof Error ? e.message : "Couldn't create the account.")}`);
  }
  const s = createSession(userId);
  await setSessionCookie(s.token, s.expires);
  redirect("/app?welcome=1");
}

export async function logoutAction() {
  const jar = await cookies();
  const t = jar.get(SESSION_COOKIE)?.value;
  if (t) deleteSession(t);
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
