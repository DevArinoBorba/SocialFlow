import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

// Each invocation owns new volumes; never reuses or removes an existing volume.
const project = `socialflow-acceptance-${Date.now()}-${randomBytes(3).toString("hex")}`;
const directory = resolve(".local", project);
mkdirSync(directory, { recursive: true });
const envFile = resolve(directory, "test.env");
const secret = () => randomBytes(24).toString("hex");
const reserved = [];
async function port() {
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  reserved.push(server);
  return server.address().port;
}
const values = {
  APP_ENV: "test",
  WEB_PORT: await port(),
  TEST_DB_PORT: await port(),
  TEST_REDIS_PORT: await port(),
  TEST_API_PORT: await port(),
  TEST_WORKER_PORT: await port(),
  TEST_STORAGE_PORT: await port(),
  POSTGRES_PASSWORD: secret(),
  RUNTIME_DB_PASSWORD: secret(),
  REDIS_PASSWORD: secret(),
  SESSION_SECRET: secret(),
  DEV_SEED_PASSWORD: secret(),
  SOCIALFLOW_IMAGE: "socialflow-test:local",
};
values.APP_URL = `http://localhost:${values.WEB_PORT}`;
writeFileSync(
  envFile,
  Object.entries(values)
    .map(([k, v]) => `${k}=${v}\n`)
    .join(""),
  { mode: 0o600, flag: "wx" },
);
const env = {
  ...process.env,
  ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])),
  TEST_ENV_FILE: envFile,
  NODE_ENV: "test",
  ALLOW_DEV_SEED: "true",
  DATABASE_URL: `postgresql://socialflow_runtime:${values.RUNTIME_DB_PASSWORD}@127.0.0.1:${values.TEST_DB_PORT}/socialflow`,
  MIGRATION_DATABASE_URL: `postgresql://socialflow_migration:${values.POSTGRES_PASSWORD}@127.0.0.1:${values.TEST_DB_PORT}/socialflow`,
  REDIS_URL: `redis://:${values.REDIS_PASSWORD}@127.0.0.1:${values.TEST_REDIS_PORT}`,
};
const docker = process.env.DOCKER_BIN || "docker";
const composeArgs = [
  "compose",
  "--env-file",
  envFile,
  "-f",
  "compose.yaml",
  "-f",
  "compose.test.yaml",
  "-p",
  project,
];
function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { env, stdio: "inherit", ...extra });
  if (result.error || result.status !== 0)
    throw new Error("Foundation drill step failed");
}
const compose = (...args) => run(docker, [...composeArgs, ...args]);
const pnpm = (...args) => {
  if (!process.env.npm_execpath)
    throw new Error("Run via pnpm test:foundation");
  run(process.execPath, [process.env.npm_execpath, ...args]);
};
const verify = (mode) =>
  run(process.execPath, [
    "--import",
    "tsx",
    "scripts/verify-operations.ts",
    mode,
  ]);
const started = Date.now();
let passed = false;
try {
  compose("config", "--quiet");
  for (const server of reserved) await new Promise((ok) => server.close(ok));
  compose("up", "--build", "--wait", "--wait-timeout", "240");
  verify("empty");
  compose("run", "--rm", "migrate");
  verify("seed");
  compose(
    "exec",
    "-T",
    "postgres",
    "createdb",
    "-U",
    "socialflow_migration",
    "bootstrap_check",
  );
  run(process.execPath, [process.env.npm_execpath, "db:migrate"], {
    env: {
      ...env,
      MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL.replace(
        /\/socialflow$/,
        "/bootstrap_check",
      ),
    },
  });
  verify("bootstrap");
  run(
    docker,
    [...composeArgs, "-f", "compose.bootstrap.yaml", "config", "--quiet"],
    {
      env: {
        ...env,
        BOOTSTRAP_PASSWORD_FILE: resolve(directory, "bootstrap-password"),
      },
    },
  );
  const failedSuites = [];
  for (const suite of ["test:integration", "test:e2e"]) {
    try {
      pnpm(suite);
    } catch {
      failedSuites.push(suite);
    }
  }
  const restoreStarted = Date.now();
  compose(
    "exec",
    "-T",
    "postgres",
    "pg_dump",
    "-U",
    "socialflow_migration",
    "-d",
    "socialflow",
    "-Fc",
    "-f",
    "/tmp/acceptance.dump",
  );
  compose(
    "exec",
    "-T",
    "postgres",
    "createdb",
    "-U",
    "socialflow_migration",
    "restore_check",
  );
  compose(
    "exec",
    "-T",
    "postgres",
    "pg_restore",
    "-U",
    "socialflow_migration",
    "-d",
    "restore_check",
    "--exit-on-error",
    "--single-transaction",
    "--no-owner",
    "/tmp/acceptance.dump",
  );
  verify("restore");
  if (failedSuites.length)
    throw new Error(`Failed suites: ${failedSuites.join(", ")}`);
  writeFileSync(
    resolve(directory, "result.json"),
    JSON.stringify(
      {
        project,
        completedAt: new Date().toISOString(),
        result: "passed",
        durationSeconds: (Date.now() - started) / 1000,
        restoreSeconds: (Date.now() - restoreStarted) / 1000,
      },
      null,
      2,
    ),
  );
  passed = true;
  console.info(`Foundation drill passed; evidence: ${directory}/result.json`);
} finally {
  for (const server of reserved) if (server.listening) server.close();
  // Preserve volumes for inspection, even on failure. No down -v or prune.
  compose("down");
  if (!passed)
    console.error(
      `Foundation drill failed; isolated volumes preserved: ${project}`,
    );
}
