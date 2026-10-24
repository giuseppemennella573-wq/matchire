"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { get } from "@/lib/db";
import { ingest, processEnquiry } from "@/lib/engine";
import { formatDate } from "@/lib/dates";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim().slice(0, 4000);

export async function submitEnquiryAction(form: FormData) {
  const slug = str(form, "slug");
  const embed = form.get("embed") ? "&embed=1" : "";
  const v = get<{ id: number }>("SELECT id FROM vendors WHERE slug = ?", slug);
  if (!v) redirect("/");
  if (str(form, "website")) redirect(`/e/${slug}?sent=1${embed}`); // honeypot
  const phone = str(form, "phone");
  const email = str(form, "email");
  if (!phone && !email) redirect(`/e/${slug}?error=${encodeURIComponent("Add a WhatsApp number or email so we can reply.")}${embed}`);

  // Structured fields go first so the reader picks them up reliably.
  const lines = [
    str(form, "date") && `Date: ${formatDate(str(form, "date"))} ${str(form, "date").slice(0, 4)}`,
    str(form, "time") && `Start time: ${str(form, "time")}`,
    str(form, "pax") && `Guests: ${str(form, "pax")} pax`,
    str(form, "message"),
  ].filter(Boolean);
  const { enquiryId } = ingest({
    vendorId: v.id,
    channel: "web",
    text: lines.join("\n"),
    name: str(form, "name"),
    handle: phone || email,
    email: email || null,
  });
  after(() => processEnquiry(v.id, enquiryId).catch((e) => console.error("processEnquiry failed", e)));
  redirect(`/e/${slug}?sent=1${embed}`);
}
