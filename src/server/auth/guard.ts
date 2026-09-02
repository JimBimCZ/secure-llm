import { auth } from "@/server/auth/config";
import type { Role } from "@/server/auth/roles";
import { logger } from "@/server/log/logger";

/**
 * The one place authorization is decided.
 *
 * Every protected route handler calls one of these first. Hiding a button in
 * the UI is decoration; this is the control (CLAUDE.md §3). Roles come from the
 * token claim on every request, never from the users table — so revoking a role
 * at the IdP takes effect on the next token, with no write to our database.
 */

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface Principal {
  sub: string;
  roles: Role[];
}

/** Requires a signed-in caller. Throws 401 otherwise. */
export async function requireUser(): Promise<Principal> {
  const session = await auth();

  if (!session?.sub) {
    throw new AuthError(401, "authentication required");
  }

  return { sub: session.sub, roles: session.roles ?? [] };
}

/** Requires a signed-in caller holding `role`. Throws 401 or 403. */
export async function requireRole(role: Role): Promise<Principal> {
  const principal = await requireUser();

  if (!principal.roles.includes(role)) {
    // Worth logging: a denied authorization attempt is a security event.
    // Subject and the role asked for — never the token.
    logger.warn(
      { sub: principal.sub, required: role, held: principal.roles },
      "authorization denied",
    );
    throw new AuthError(403, "insufficient role");
  }

  return principal;
}

/**
 * Turns an AuthError into a response. Route handlers stay three lines long and
 * cannot accidentally return 200 on a thrown guard.
 */
export function authErrorResponse(error: unknown): Response | null {
  if (!(error instanceof AuthError)) return null;

  return Response.json(
    { error: error.message },
    { status: error.status },
  );
}
