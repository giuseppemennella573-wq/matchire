"use server";

import { cookies } from "next/headers";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { createAccount, createSession, deleteSession, login } from "@/lib/accounts";
import { SESSION_COOKIE, setSessionCookie } from "@/lib/auth";
import type { VendorKind } from "@/lib/types";
import { notifyNewAccount } from "@/lib/early-access";
import { requestPasswordReset, resetPassword } from "@/lib/password-reset";
import { appUrl } from "@/lib/app-url";

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
  const newUser = userId;
  after(async () => {
    const error = await notifyNewAccount(newUser);
    if (error) console.warn(`[signup] new-account alert not sent: ${error}`);
  });
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

export async function forgotPasswordAction(form: FormData) {
  const email = str(form, "email");
  if (email) {
    const result = await requestPasswordReset(email, appUrl());
    if (result !== "sent" && result !== "no_account" && result !== "demo") console.warn(`[password-reset] not sent: ${result}`);
  }
  // Same answer whether or not the address has an account.
  redirect("/forgot?sent=1");
}

export async function resetPasswordAction(form: FormData) {
  const t = str(form, "token");
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) redirect(`/reset/${encodeURIComponent(t)}?error=${encodeURIComponent("The two passwords don't match.")}`);
  const r = resetPassword(t, password);
  if (!r.ok) redirect(`/reset/${encodeURIComponent(t)}?error=${encodeURIComponent(r.error)}`);
  redirect(`/login?msg=${encodeURIComponent("Password updated. Log in with your new password.")}`);
}
