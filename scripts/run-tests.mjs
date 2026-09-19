import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
const values = parseEnv(
  readFileSync(process.env.TEST_ENV_FILE ?? ".local/test.env", "utf8"),
);
const env = {
  ...process.env,
  ...values,
  NODE_ENV: "test",
  ALLOW_DEV_SEED: "true",
  DATABASE_URL: `postgresql://socialflow_runtime:${values.RUNTIME_DB_PASSWORD}@127.0.0.1:${values.TEST_DB_PORT ?? 55432}/socialflow`,
  MIGRATION_DATABASE_URL: `postgresql://socialflow_migration:${values.POSTGRES_PASSWORD}@127.0.0.1:${values.TEST_DB_PORT ?? 55432}/socialflow`,
  REDIS_URL: `redis://:${values.REDIS_PASSWORD}@127.0.0.1:${values.TEST_REDIS_PORT ?? 56379}`,
  MEDIA_S3_ENDPOINT: `http://127.0.0.1:${values.TEST_STORAGE_PORT ?? 59000}`,
  MEDIA_S3_BUCKET: "socialflow-media-test",
  MEDIA_S3_ACCESS_KEY_ID: "socialflow-test",
  MEDIA_S3_SECRET_ACCESS_KEY: "isolated-media-test-secret",
};
const mode = process.argv[2];
const args =
  mode === "integration"
    ? [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "vitest.integration.config.ts",
        ...process.argv.slice(3),
      ]
    : mode === "e2e"
      ? ["node_modules/@playwright/test/cli.js", "test"]
      : mode === "migrate"
        ? ["node_modules/prisma/build/index.js", "migrate", "deploy"]
        : mode === "seed"
          ? ["--import", "tsx", "src/seed.ts"]
          : null;
if (!args)
  throw new Error(
    "Execute via pnpm exec node scripts/run-tests.mjs integration|e2e|migrate|seed",
  );
const result = spawnSync(process.execPath, args, {
  env,
  stdio: "inherit",
  cwd: ["migrate", "seed"].includes(mode) ? "packages/db" : ".",
});
process.exit(result.status ?? 1);
