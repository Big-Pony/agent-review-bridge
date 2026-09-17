/**
 * Invitee permission level, shared by all providers.
 *
 * Owner decision 2026-09-13: invitees default to MAX permissions so headless
 * rounds never stall on permission prompts ("避免因为权限问题导致中断或者等待").
 * Set ARB_INVITEE_PERMISSIONS=readonly to restore the original spec-2.2
 * read-only review mode.
 */
export type InviteePermissions = "max" | "readonly";

export function inviteePermissions(): InviteePermissions {
  return process.env.ARB_INVITEE_PERMISSIONS === "readonly" ? "readonly" : "max";
}
