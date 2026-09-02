import NextAuth, { customFetch, type NextAuthConfig } from "next-auth";

import { rolesFromClaims, type Role } from "@/server/auth/roles";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { env, idpFetch } from "@/server/env";
import { logger } from "@/server/log/logger";
import { seedUserIfEmpty } from "@/server/rag/seed";

declare module "next-auth" {
  interface Session {
    roles: Role[];
    sub: string;
  }
}

/**
 * One generic OIDC provider, configured entirely from environment variables.
 * The id is "oidc", not a vendor name, so the callback URL carries no provider
 * name either — swapping the IdP never edits this file.
 */
const config: NextAuthConfig = {
  providers: [
    {
      id: "oidc",
      name: "Single sign-on",
      type: "oidc",
      issuer: env.OIDC_ISSUER,
      // Auth.js always discovers from the issuer URL — the address the browser
      // uses — so on a container network the server needs its own way there.
      // This is the supported hook for that, and a no-op against a public IdP.
      [customFetch]: idpFetch,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      authorization: { params: { scope: env.OIDC_SCOPES } },
      // Without this, Auth.js invents its own user id and puts THAT in
      // token.sub — a fresh random value on every sign-in. Everything the user
      // owns is keyed by subject, so that id must be the IdP's `sub` and
      // nothing else.
      profile: (profile) => ({
        id: profile.sub,
        name: profile.name ?? null,
        email: profile.email ?? null,
      }),
    },
  ],

  // No database adapter: sessions are stateless JWTs. There is no session table
  // and no user table the IdP does not own — see CLAUDE.md §3.
  session: { strategy: "jwt" },

  trustHost: true,

  callbacks: {
    async jwt({ token, profile }) {
      // `profile` is present only on the sign-in request. Roles are read from
      // the token claims then, and carried in our own session token after.
      if (profile) {
        // Belt and braces: pin the subject to the IdP's, not Auth.js's.
        if (profile.sub) token.sub = profile.sub;
        token.roles = rolesFromClaims(profile as Record<string, unknown>);
      }
      return token;
    },

    async session({ session, token }) {
      session.sub = token.sub ?? "";
      session.roles = (token.roles as Role[] | undefined) ?? [];
      return session;
    },
  },

  events: {
    async signIn({ profile }) {
      const sub = profile?.sub;
      if (!sub) return;

      const roles = rolesFromClaims((profile ?? {}) as Record<string, unknown>);

      // Keep the local projection current. This row holds no credentials.
      await db
        .insert(users)
        .values({
          sub,
          displayName: profile?.name ?? null,
          email: profile?.email ?? null,
          roleSnapshot: roles.join(","),
        })
        .onConflictDoUpdate({
          target: users.sub,
          set: {
            displayName: profile?.name ?? null,
            email: profile?.email ?? null,
            roleSnapshot: roles.join(","),
            lastSeenAt: new Date(),
          },
        });

      // Log the event, not the person: subject and roles, never name or email.
      logger.info({ sub, roles }, "sign-in");

      // A new user starts with the synthetic corpus so there is something to
      // search immediately. No-op for anyone who already has documents.
      await seedUserIfEmpty(sub);
    },

    async signOut(message) {
      const sub = "token" in message ? message.token?.sub : undefined;
      logger.info({ sub }, "sign-out");
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(config);
