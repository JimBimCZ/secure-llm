import { auth, signIn, signOut } from "@/server/auth/config";

/**
 * The one header, rendered by the root layout on every page.
 *
 * Sign out has to be reachable from wherever the user happens to be — a session
 * you can only end by first navigating home is a session that gets left open on
 * a shared machine. Home is here for the same reason: every page needs a way
 * back that is not the browser's back button.
 *
 * It is a server component so the session is read on the server and the sign
 * in/out actions are server actions; there is no client-side session state to
 * go stale.
 */
export async function SiteHeader() {
  const session = await auth();
  const signedIn = Boolean(session?.sub);

  return (
    <header className="border-b border-slate-200">
      <nav className="mx-auto flex max-w-3xl items-center gap-6 px-6 py-3">
        <a className="font-medium" href="/">
          Personal knowledge base
        </a>

        {signedIn && (
          <div className="flex gap-4 text-sm text-slate-600">
            <a className="hover:text-slate-900 hover:underline" href="/ask">
              Ask
            </a>
            <a className="hover:text-slate-900 hover:underline" href="/documents">
              Documents
            </a>
          </div>
        )}

        <div className="ml-auto flex items-center gap-3 text-sm">
          {signedIn ? (
            <>
              <span className="hidden text-slate-500 sm:inline">
                {session?.user?.name ?? session?.sub}
              </span>
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/" });
                }}
              >
                <button
                  type="submit"
                  className="cursor-pointer rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-50"
                >
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <form
              action={async () => {
                "use server";
                await signIn("oidc", { redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="cursor-pointer rounded bg-slate-900 px-3 py-1.5 text-white"
              >
                Sign in
              </button>
            </form>
          )}
        </div>
      </nav>
    </header>
  );
}
