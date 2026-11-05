import { createHash, timingSafeEqual } from "node:crypto";

// /signup is behind the early-access waitlist. One invite code (SIGNUP_INVITE_CODE)
// opens the normal signup, for vendors Giuseppe onboards. No code set: nobody gets in.

export const inviteCode = () => process.env.SIGNUP_INVITE_CODE?.trim() || null;

const digest = (s: string) => createHash("sha256").update(s).digest();

export function validInvite(code: string | null | undefined): boolean {
  const expected = inviteCode();
  const given = code?.trim();
  if (!expected || !given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}
