// Emails written by machines: out-of-office replies, newsletters, bounces and
// no-reply senders. They're filed under Other with a reason, never read by the
// AI and never answered (an auto-reply to an auto-reply can loop forever).

export type Headers = Record<string, string>;

/** Header names lower-cased, from Postmark (array of {Name, Value}), Mailgun ([name, value] pairs, maybe as JSON) or SendGrid (raw block). */
export function parseHeaders(raw: unknown): Headers {
  const out: Headers = {};
  const put = (k: unknown, v: unknown) => {
    if (typeof k === "string" && k.trim()) out[k.trim().toLowerCase()] = String(v ?? "").trim();
  };
  let value = raw;
  if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("[") || s.startsWith("{")) {
      try { value = JSON.parse(s); } catch { /* not JSON: a raw header block */ }
    }
    if (typeof value === "string") {
      // Raw block: "Name: value" lines, with folded continuation lines.
      for (const line of value.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i > 0) put(line.slice(0, i), line.slice(i + 1));
      }
      return out;
    }
  }
  if (Array.isArray(value)) {
    for (const h of value) {
      if (Array.isArray(h)) put(h[0], h[1]);
      else if (h && typeof h === "object") put((h as { Name?: string; name?: string }).Name ?? (h as { name?: string }).name, (h as { Value?: string; value?: string }).Value ?? (h as { value?: string }).value);
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) put(k, v);
  }
  return out;
}

/** Why an email is automated ("Out-of-office reply", "Newsletter", "Delivery failure", "Automatic email"), or null for a person's email. */
export function automatedReason(h: Headers, from: string, subject: string): string | null {
  const sender = from.toLowerCase();
  const subj = subject.trim().toLowerCase();
  if (/(^|[<\s"])(mailer-daemon|postmaster)@/.test(sender) || /^(undeliverable|undelivered mail|delivery status notification|mail delivery (failed|failure|subsystem))/.test(subj)) return "Delivery failure";
  const autoSubmitted = (h["auto-submitted"] ?? "").toLowerCase();
  if (autoSubmitted === "auto-replied" || "x-autoreply" in h || "x-autorespond" in h || /^(auto:|automatic reply|auto(matic)?[- ]?response|out of (the )?office|ooo\b)/.test(subj)) return "Out-of-office reply";
  const precedence = (h["precedence"] ?? "").toLowerCase();
  if ("list-unsubscribe" in h || "list-id" in h || precedence === "bulk" || precedence === "list") return "Newsletter";
  if ((autoSubmitted && autoSubmitted !== "no") || precedence === "junk" || /(^|[<\s"])(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?)@/.test(sender)) return "Automatic email";
  return null;
}
