import { z } from "zod";

/**
 * Every environment variable the app reads is declared here, once.
 * Adding a variable means touching three places together: this schema,
 * `.env.example`, and the README. See CLAUDE.md §8.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),

  // --- Identity -------------------------------------------------------
  // Nothing here names a provider. Swapping to Microsoft Entra ID is a change
  // of these values only; see the README.
  AUTH_SECRET: z.string().min(16),
  AUTH_URL: z.string().min(1),
  OIDC_ISSUER: z.string().min(1),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  OIDC_SCOPES: z.string().min(1).default("openid profile email"),
  OIDC_ROLES_CLAIM: z.string().min(1).default("roles"),

  // Only needed when the server reaches the IdP at a different origin than the
  // browser does — the case for a mock IdP on a container network. Against a
  // public IdP such as Entra ID this stays unset and both use OIDC_ISSUER.
  OIDC_INTERNAL_ORIGIN: z.string().min(1).optional(),

  // --- Embeddings -----------------------------------------------------
  // `local` runs the model in this process; `mock` is a deterministic hashing
  // embedder with no model, used by tests and anywhere the model is absent.
  EMBEDDING_PROVIDER: z.enum(["local", "mock"]).default("local"),
  EMBEDDING_MODEL: z.string().min(1).default("Xenova/all-MiniLM-L6-v2"),
  EMBEDDING_CACHE_DIR: z.string().min(1).default("./.models"),

  // --- Answering ------------------------------------------------------
  // `mock` is the default because the app must be fully demoable with no API
  // key set (CLAUDE.md §5). It extracts from the retrieved chunks instead of
  // generating; `anthropic` is the real run.
  LLM_PROVIDER: z
    .enum(["anthropic", "openrouter", "gateway", "mock"])
    .default("mock"),
  LLM_MODEL: z.string().min(1).default("claude-opus-5"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  LLM_GATEWAY_BASE_URL: z.string().min(1).optional(),
  LLM_GATEWAY_API_KEY: z.string().min(1).optional(),

  // --- Retrieval ------------------------------------------------------
  RAG_TOP_K: z.coerce.number().int().positive().max(50).default(6),
  // Cosine similarity below which the corpus is treated as not containing the
  // answer. Both embedders produce unit vectors, so the number means the same
  // thing in either mode. Tuned against the seed corpus — see the README.
  RAG_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.25),

  // --- Retention ------------------------------------------------------
  // How long an LLM audit record (model, time, tokens, latency, outcome) is
  // kept before the hourly purge removes it. Fractional and zero are allowed
  // on purpose: a retention policy you cannot demonstrate is one nobody
  // believes, and `RETENTION_AUDIT_DAYS=0` makes the purge provable in one
  // restart. There is no matching variable for application logs — those go to
  // stdout and this process never stores them, so their retention belongs to
  // the operator's log collector.
  RETENTION_AUDIT_DAYS: z.coerce.number().min(0).default(30),
});

export type Env = z.infer<typeof envSchema>;

/**
 * `next build` imports every route module to read its config exports, which
 * reaches this file. The build needs no real configuration — it opens no
 * connection and calls no IdP. Validating during the build would force
 * placeholder secrets into the image just to satisfy the schema, so the build
 * phase gets obviously-fake values instead and nothing fake is ever baked in.
 *
 * The running server always takes the real path below, so a genuine
 * misconfiguration still fails at startup, before the first request.
 */
const BUILD_PHASE_PLACEHOLDERS: Env = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://build-phase/unused",
  LOG_LEVEL: "info",
  AUTH_SECRET: "build-phase-placeholder-unused",
  AUTH_URL: "http://build-phase.invalid",
  OIDC_ISSUER: "http://build-phase.invalid",
  OIDC_CLIENT_ID: "build-phase-unused",
  OIDC_CLIENT_SECRET: "build-phase-unused",
  OIDC_SCOPES: "openid profile email",
  OIDC_ROLES_CLAIM: "roles",
  OIDC_INTERNAL_ORIGIN: undefined,
  EMBEDDING_PROVIDER: "mock",
  EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
  EMBEDDING_CACHE_DIR: "./.models",
  LLM_PROVIDER: "mock",
  LLM_MODEL: "claude-opus-5",
  LLM_TIMEOUT_MS: 60_000,
  ANTHROPIC_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  LLM_GATEWAY_BASE_URL: undefined,
  LLM_GATEWAY_API_KEY: undefined,
  RAG_TOP_K: 6,
  RAG_MIN_SCORE: 0.25,
  RETENTION_AUDIT_DAYS: 30,
};

/**
 * An unset variable does not arrive as absent — it arrives as "".
 *
 * `.env.example` ships blank values for the credentials that are only needed in
 * one mode (`ANTHROPIC_API_KEY=`), and Docker Compose turns an interpolation of
 * an unset variable into an empty string too. Zod sees "" as a present value,
 * so a blank optional fails `.min(1)` and a blank enum never reaches its
 * default. Treating empty as absent is what everyone already assumes is
 * happening, and it makes `cp .env.example .env && docker compose up` work.
 */
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  ) as Record<string, string>;
}

function loadEnv(): Env {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return BUILD_PHASE_PLACEHOLDERS;
  }

  const parsed = envSchema.safeParse(withoutBlanks(process.env));

  if (!parsed.success) {
    // Report variable NAMES only. The offending value may itself be a secret,
    // and this message ends up in logs and terminal output.
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new Error(
      `Invalid environment configuration. Check these variables: ${names.join(", ")}`,
    );
  }

  const config = parsed.data;

  // A provider selected without its credential is a configuration mistake, and
  // it must fail here rather than on the first question a user asks. There is
  // deliberately no silent fallback to `mock`: an app that quietly stops using
  // the model you paid for, and answers differently because of it, is worse
  // than one that refuses to start.
  if (config.LLM_PROVIDER === "anthropic" && !config.ANTHROPIC_API_KEY) {
    throw new Error(
      "LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY. Use LLM_PROVIDER=mock to run without a key.",
    );
  }
  if (config.LLM_PROVIDER === "openrouter" && !config.OPENROUTER_API_KEY) {
    throw new Error(
      "LLM_PROVIDER=openrouter requires OPENROUTER_API_KEY. Use LLM_PROVIDER=mock to run without a key.",
    );
  }
  if (config.LLM_PROVIDER === "gateway" && !config.LLM_GATEWAY_BASE_URL) {
    throw new Error("LLM_PROVIDER=gateway requires LLM_GATEWAY_BASE_URL.");
  }

  return config;
}

export const env = loadEnv();

/**
 * Server-side fetch to the IdP.
 *
 * Auth.js discovers from the issuer URL, which is by definition the address the
 * BROWSER uses. On a container network the server cannot reach that address, so
 * requests aimed at the issuer's origin are redirected to the internal one.
 * Nothing else about the request changes, and the issuer in every token stays
 * the public one, so `iss` validation is unaffected.
 *
 * With a public IdP the two origins are the same and this is a plain fetch.
 */
export const idpFetch: typeof fetch = (input, init) => {
  const internal = env.OIDC_INTERNAL_ORIGIN;
  if (!internal) return fetch(input, init);

  const requested = new URL(
    input instanceof Request ? input.url : String(input),
  );
  if (requested.origin !== new URL(env.OIDC_ISSUER).origin) {
    return fetch(input, init);
  }

  const rewritten = new URL(
    requested.pathname + requested.search,
    internal,
  );
  return input instanceof Request
    ? fetch(new Request(rewritten, input), init)
    : fetch(rewritten, init);
};
