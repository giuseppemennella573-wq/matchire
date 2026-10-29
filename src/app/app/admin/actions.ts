"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireVendor } from "@/lib/auth";
import { deleteAccount, deleteSignup, isAdmin, notifySignup, setAccountContacted, setContacted } from "@/lib/early-access";
import { createBackup } from "@/lib/backup";
import { get } from "@/lib/db";
import { requestPasswordReset } from "@/lib/password-reset";
import { appUrl } from "@/lib/app-url";
import { emailReady } from "@/lib/channels";

async function requireAdmin() {
  const { user } = await requireVendor();
  if (!isAdmin(user)) redirect("/app");
}

const signupId = (f: FormData) => {
  const n = Number(f.get("id"));
  if (!Number.isInteger(n) || n <= 0) throw new Error("Bad request");
  return n;
};

export async function toggleContactedAction(form: FormData) {
  await requireAdmin();
  setContacted(signupId(form), form.get("contacted") === "1");
  revalidatePath("/app", "layout");
  redirect("/app/admin");
}

export async function toggleAccountContactedAction(form: FormData) {
  await requireAdmin();
  setAccountContacted(signupId(form), form.get("contacted") === "1");
  revalidatePath("/app", "layout");
  redirect("/app/admin/accounts");
}

export async function deleteAccountAction(form: FormData) {
  await requireAdmin();
  let msg: string, kind = "msg";
  try {
    msg = `${deleteAccount(signupId(form)).business} deleted. Their logins no longer work.`;
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
    kind = "error";
  }
  revalidatePath("/app", "layout");
  redirect(`/app/admin/accounts?${kind}=${encodeURIComponent(msg)}`);
}

export async function deleteSignupAction(form: FormData) {
  await requireAdmin();
  deleteSignup(signupId(form));
  revalidatePath("/app", "layout");
  redirect(`/app/admin?msg=${encodeURIComponent("Sign-up deleted.")}`);
}

export async function backupNowAction() {
  await requireAdmin();
  let msg: string, kind = "msg";
  try {
    const b = await createBackup("manual");
    if (b.emailed_at) msg = "Backup taken and emailed.";
    else if (!emailReady()) msg = "Backup taken and saved here.";
    else { msg = `Backup taken and saved here, but not emailed: ${b.email_error}`; kind = "error"; }
  } catch (e) {
    msg = `Backup failed: ${e instanceof Error ? e.message : String(e)}`;
    kind = "error";
  }
  redirect(`/app/admin/backups?${kind}=${encodeURIComponent(msg)}`);
}

export async function resendAlertAction(form: FormData) {
  await requireAdmin();
  const error = await notifySignup(signupId(form));
  redirect(`/app/admin?${error ? "error" : "msg"}=${encodeURIComponent(error ?? "Alert email sent.")}`);
}

export async function sendResetLinkAction(form: FormData) {
  await requireAdmin();
  const u = get<{ email: string }>("SELECT email FROM users WHERE id = ?", signupId(form));
  const result = u ? await requestPasswordReset(u.email, appUrl()) : "Account not found";
  const msg = result === "sent" ? `Reset link sent to ${u!.email}. It expires in 1 hour.`
    : result === "rate_limited" ? "Three reset links were already sent in the last hour. Try again later."
    : `Couldn't send the reset link: ${result}`;
  redirect(`/app/admin/accounts?${result === "sent" ? "msg" : "error"}=${encodeURIComponent(msg)}`);
}
