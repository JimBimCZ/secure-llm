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

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = path.join(SRC, `${specifier.slice(2)}.ts`);
      return nextResolve(pathToFileURL(target).href, context);
    }

    // Relative sibling imports carry no extension in TypeScript source.
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !path.extname(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }

    return nextResolve(specifier, context);
  },
});
