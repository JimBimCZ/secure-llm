import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Lets `node --test` resolve the imports the app actually uses.
 *
 * Node runs TypeScript directly (type stripping) but knows nothing about the
 * `@/*` path alias in tsconfig.json, and ESM requires a file extension where
 * TypeScript does not. Rather than reshape the application's import style to
 * suit the test runner — which would put test concerns in production files —
 * the two rules live here, in one place, with no dependency.
 */
const SRC = path.join(import.meta.dirname, "..", "src");
const OURS = [pathToFileURL(SRC).href, pathToFileURL(import.meta.dirname).href];

const isOurs = (parentURL: string | undefined) =>
  parentURL !== undefined && OURS.some((dir) => parentURL.startsWith(dir));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const base = path.join(SRC, specifier.slice(2));
      // `@/server/ai` is a folder with an index.ts, which is a resolution
      // TypeScript does and ESM does not.
      const target = existsSync(`${base}.ts`) ? `${base}.ts` : path.join(base, "index.ts");
      return nextResolve(pathToFileURL(target).href, context);
    }

    // Relative sibling imports carry no extension in TypeScript source. Only
    // ours: a dependency's own extensionless `require("./lib/err")` is
    // CommonJS, resolves perfectly well on its own, and must not be handed a
    // `.ts` it does not have.
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !path.extname(specifier) &&
      isOurs(context.parentURL)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }

    return nextResolve(specifier, context);
  },
});
