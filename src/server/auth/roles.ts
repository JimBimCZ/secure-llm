import { env } from "@/server/env";

/** The two roles the app knows about. Everything else in a token is ignored. */
export const ROLES = ["user", "admin"] as const;
export type Role = (typeof ROLES)[number];

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Pull roles out of a token's claims. The claim name is configuration
 * (`OIDC_ROLES_CLAIM`) because different providers put them in different
 * places: Keycloak uses a flat `roles` claim here, Entra ID uses `roles` too,
 * others nest them. Only the claim name changes, never this code.
 *
 * Accepts either an array or a space-delimited string, which covers every
 * provider shape we have needed so far.
 */
export function rolesFromClaims(claims: Record<string, unknown>): Role[] {
  const raw = claims[env.OIDC_ROLES_CLAIM];

  const candidates = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(" ")
      : [];

  return [...new Set(candidates.filter(isRole))];
}
