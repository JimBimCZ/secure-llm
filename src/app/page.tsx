import { auth, signIn, signOut } from "@/server/auth/config";

import { DeleteAccount } from "./delete-account";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await auth();

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold">Personal knowledge base</h1>
      <p className="mt-3 text-slate-600">
        Ask questions of your own notes. Every answer cites the document it came
        from.
      </p>

      {session?.sub ? (
        <div className="mt-8 rounded border border-slate-200 p-4">
          <p className="text-sm text-slate-600">
            Signed in as{" "}
            <span className="font-medium text-slate-900">
              {session.user?.name ?? session.sub}
            </span>
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Roles:{" "}
            {session.roles.length > 0 ? (
              <span className="font-mono">{session.roles.join(", ")}</span>
            ) : (
              <span className="italic">none</span>
            )}
          </p>
          <div className="mt-4 flex gap-4 text-sm">
            <a className="underline" href="/ask">
              Ask your notes
            </a>
            <a className="underline" href="/documents">
              Your documents
            </a>
          </div>
          {/* Sign out lives in the header, on every page. */}
          <DeleteAccount
            signOutAction={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          />
        </div>
      ) : (
        <form
          action={async () => {
            "use server";
            await signIn("oidc", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="mt-8 cursor-pointer rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
          >
            Sign in
          </button>
        </form>
      )}

      <p className="mt-8 text-sm text-slate-500">
        Service status at{" "}
        <a className="underline" href="/api/health">
          /api/health
        </a>
        . The guard is visible at{" "}
        <a className="underline" href="/api/me">
          /api/me
        </a>{" "}
        and{" "}
        <a className="underline" href="/api/admin/stats">
          /api/admin/stats
        </a>{" "}
        (admin only).
      </p>
    </main>
  );
}
