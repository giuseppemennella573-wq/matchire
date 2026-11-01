"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { endSupport, notifySupportStart, startSupport, SUPPORT_COOKIE } from "@/lib/support";
import { after } from "next/server";
import { deleteAccount, deleteSignup, notifySignup, setAccountContacted, setContacted } from "@/lib/early-access";
import { createBackup, deleteUnencryptedBackups } from "@/lib/backup";
import { get } from "@/lib/db";
import { requestPasswordReset } from "@/lib/password-reset";
import { appUrl } from "@/lib/app-url";
import { seedDemo } from "@/lib/demo";
import { channelChangesFromForm, updateChannels } from "@/lib/channel-settings";
import { emailReady } from "@/lib/channels";


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
    if (b.emailed_at) msg = "Backup taken, encrypted and emailed.";
    else if (!b.file.endsWith(".enc")) msg = "Backup taken and saved here. It isn't encrypted or emailed until BACKUP_PASSWORD is set.";
    else if (!emailReady()) msg = "Backup taken, encrypted and saved here.";
    else { msg = `Backup taken and saved here, but not emailed: ${b.email_error}`; kind = "error"; }
  } catch (e) {
    msg = `Backup failed: ${e instanceof Error ? e.message : String(e)}`;
    kind = "error";
  }
  redirect(`/app/admin/backups?${kind}=${encodeURIComponent(msg)}`);
}

export async function deleteUnencryptedBackupsAction() {
  await requireAdmin();
  const n = deleteUnencryptedBackups();
  redirect(`/app/admin/backups?msg=${encodeURIComponent(n ? `${n} unencrypted backup${n === 1 ? "" : "s"} deleted.` : "No unencrypted backups to delete.")}`);
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
    : result === "demo" ? "Demo accounts use DEMO_PASSWORD, so no reset email is sent. Reset the demo to apply a new password."
    : `Couldn't send the reset link: ${result}`;
  redirect(`/app/admin/accounts?${result === "sent" ? "msg" : "error"}=${encodeURIComponent(msg)}`);
}

export async function resetDemoAction() {
  await requireAdmin();
  let msg: string, kind = "msg";
  try {
    const r = await seedDemo();
    msg = `Demo reset: Snap & Smile has ${r.enquiries} fresh enquiries and ${r.bookedSaturday} is fully booked.`;
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
    kind = "error";
  }
  revalidatePath("/app", "layout");
  redirect(`/app/admin/accounts?${kind}=${encodeURIComponent(msg)}`);
}

export async function saveVendorChannelsAction(form: FormData) {
  const { user } = await requireAdmin();
  const vendorId = Number(form.get("vendorId"));
  if (!Number.isInteger(vendorId) || vendorId <= 0) throw new Error("Bad request");
  const back = `/app/admin/channels/${vendorId}`;
  let msg: string, kind = "msg";
  try {
    const changed = await updateChannels(vendorId, { ...channelChangesFromForm(form), rotateInbound: form.get("rotate_inbound") === "on" }, { id: user.id, email: user.email, admin: true });
    msg = changed.length ? `Saved: ${changed.join(", ")}.` : "Nothing changed.";
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
    kind = "error";
  }
  revalidatePath("/app", "layout");
  redirect(`${back}?${kind}=${encodeURIComponent(msg)}`);
}

export async function startSupportAction(form: FormData) {
  const { user } = await requireAdmin();
  const vendorId = Number(form.get("vendorId"));
  if (!Number.isInteger(vendorId) || vendorId <= 0) throw new Error("Bad request");
  let started: ReturnType<typeof startSupport>;
  try {
    started = startSupport(user, vendorId, String(form.get("reason") ?? ""));
  } catch (e) {
    redirect(`/app/admin/support/${vendorId}?error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
  }
  const jar = await cookies();
  const access = started.access;
  after(() => notifySupportStart(access));
  jar.set(SUPPORT_COOKIE, started.token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires: new Date(started.access.expires_at) });
  revalidatePath("/app", "layout");
  redirect("/app");
}

/** Ends the support view now. (Once someone isn't an admin, the cookie no longer opens anything.) */
export async function endSupportAction() {
  await requireAdmin();
  const jar = await cookies();
  const ended = endSupport(jar.get(SUPPORT_COOKIE)?.value, "admin");
  jar.delete(SUPPORT_COOKIE);
  revalidatePath("/app", "layout");
  redirect(`/app/admin/accounts?msg=${encodeURIComponent(ended ? "Support view ended." : "Support view already ended.")}`);
}
