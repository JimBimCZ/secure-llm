/**
 * The configuration the tests run against.
 *
 * `src/server/env.ts` validates the whole environment the moment it is
 * imported and throws if anything required is missing — deliberately, so a
 * misconfigured server dies at startup rather than on someone's first
 * question. That check does not know it is being imported by a test, so the
 * tests have to look like a configured process.
 *
 * Every value here is obviously fake and reaches nothing. The database URL
 * points at a host that does not exist, because no test may open a connection;
 * a test that needs a database is a test that would silently start passing for
 * the wrong reason. Both providers are the ones that need no key and no model.
 *
 * `??=`, so a variable already set — by the shell, or by a test that starts a
 * stub server and points the app at it — wins over the default.
 */
const DEFAULTS: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/unused",
  // Quiet. The code under test logs on purpose, and asserting on log lines is
  // not what these tests are for.
  LOG_LEVEL: "fatal",
  AUTH_SECRET: "test-secret-not-a-real-one",
  AUTH_URL: "http://localhost:3000",
  OIDC_ISSUER: "http://localhost:8080/realms/test",
  OIDC_CLIENT_ID: "test-client",
  OIDC_CLIENT_SECRET: "test-client-secret",
  EMBEDDING_PROVIDER: "mock",
  LLM_PROVIDER: "mock",
  LLM_MODEL: "test-model",
};

for (const [name, value] of Object.entries(DEFAULTS)) {
  process.env[name] ??= value;
}
