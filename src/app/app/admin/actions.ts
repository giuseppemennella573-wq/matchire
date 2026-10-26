"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireVendor } from "@/lib/auth";
import { deleteSignup, isAdmin, notifySignup, setContacted } from "@/lib/early-access";

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

export async function deleteSignupAction(form: FormData) {
  await requireAdmin();
  deleteSignup(signupId(form));
  revalidatePath("/app", "layout");
  redirect(`/app/admin?msg=${encodeURIComponent("Sign-up deleted.")}`);
}

export async function resendAlertAction(form: FormData) {
  await requireAdmin();
  const error = await notifySignup(signupId(form));
  redirect(`/app/admin?${error ? "error" : "msg"}=${encodeURIComponent(error ?? "Alert email sent.")}`);
}
