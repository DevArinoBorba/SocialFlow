import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  asActor,
  assertRuntimeRole,
  createDatabase,
  type PrismaClient,
} from "@socialflow/db";
import { bootstrap } from "../packages/db/src/bootstrap.js";
import { createAuth } from "../apps/api/src/auth.js";
import { readConfig } from "../packages/config/src/index.js";

const migrationURL = process.env.MIGRATION_DATABASE_URL!;
const runtimeURL = process.env.DATABASE_URL!;
const source = createDatabase(migrationURL);
const clients: PrismaClient[] = [source];
function database(url: string, name: string) {
  const target = new URL(url);
  target.pathname = `/${name}`;
  const db = createDatabase(target.toString());
  clients.push(db);
  return db;
}
async function fingerprint(db: PrismaClient) {
  const data = await Promise.all([
    db.user.findMany({ orderBy: { id: "asc" } }),
    db.account.findMany({ orderBy: { id: "asc" } }),
    db.organization.findMany({ orderBy: { id: "asc" } }),
    db.client.findMany({ orderBy: { id: "asc" } }),
    db.brand.findMany({ orderBy: { id: "asc" } }),
    db.membership.findMany({ orderBy: { id: "asc" } }),
    db.auditLog.findMany({ orderBy: { id: "asc" } }),
    db.session.findMany({ orderBy: { id: "asc" } }),
    db.verification.findMany({ orderBy: { id: "asc" } }),
    db.rateLimit.findMany({ orderBy: { id: "asc" } }),
    db.$queryRaw`SELECT migration_name, checksum, finished_at FROM _prisma_migrations ORDER BY migration_name`,
  ]);
  return createHash("sha256")
    .update(
      JSON.stringify(data, (_, value) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    )
    .digest("hex");
}
async function login(db: PrismaClient, email: string, password: string) {
  const auth = createAuth(db, readConfig(process.env));
  const response = await auth.handler(
    new Request(`${process.env.APP_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: process.env.APP_URL!,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    }),
  );
  // Never include auth payload/cookies in assertion output.
  assert.equal(response.status, 200);
}
try {
  switch (process.argv[2]) {
    case "empty": {
      assert.equal(await source.user.count(), 0);
      assert.equal(await source.organization.count(), 0);
      const migrations = await source.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
      assert.equal(Number(migrations[0]?.count), 4);
      break;
    }
    case "seed": {
      const seed = (extra = {}) =>
        spawnSync(process.execPath, [process.env.npm_execpath!, "db:seed"], {
          env: { ...process.env, ...extra },
          stdio: "pipe",
        });
      assert.equal(seed({ NODE_ENV: "production" }).status, 1);
      assert.equal(await source.user.count(), 0);
      assert.equal(seed().status, 0);
      assert.equal(await source.user.count(), 6);
      const original = await source.client.findUniqueOrThrow({
        where: { id: "client-a" },
      });
      await source.client.update({
        where: { id: original.id },
        data: { name: "Preserved operator edit" },
      });
      const before = await fingerprint(source);
      assert.equal(
        seed({ DEV_SEED_PASSWORD: randomBytes(24).toString("hex") }).status,
        0,
      );
      assert.equal(await fingerprint(source), before);
      await source.client.update({
        where: { id: original.id },
        data: { name: original.name },
      });
      break;
    }
    case "bootstrap": {
      const target = new URL(migrationURL);
      target.pathname = "/bootstrap_check";
      const db = database(migrationURL, "bootstrap_check");
      const runtime = database(runtimeURL, "bootstrap_check");
      const inputs = {
        MIGRATION_DATABASE_URL: target.toString(),
        ALLOW_INITIAL_BOOTSTRAP: "true",
        BOOTSTRAP_EMAIL: "Initial.Owner@example.test",
        BOOTSTRAP_NAME: "Initial Owner",
        BOOTSTRAP_ORGANIZATION: "Initial Agency",
        BOOTSTRAP_PASSWORD: randomBytes(24).toString("hex"),
      };
      await assert.rejects(
        bootstrap({ ...inputs, ALLOW_INITIAL_BOOTSTRAP: "false" }),
      );
      await assert.rejects(
        bootstrap({ ...inputs, BOOTSTRAP_PASSWORD: "short" }),
      );
      assert.equal(await db.user.count(), 0);
      const passwordFile = resolve(
        dirname(process.env.TEST_ENV_FILE!),
        "bootstrap-password",
      );
      writeFileSync(passwordFile, inputs.BOOTSTRAP_PASSWORD, {
        mode: 0o600,
        flag: "wx",
      });
      const invoke = () =>
        new Promise<number | null>((ok, fail) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "packages/db/src/bootstrap-cli.ts"],
            {
              env: {
                ...process.env,
                ...inputs,
                NODE_ENV: "production",
                BOOTSTRAP_PASSWORD: undefined,
                BOOTSTRAP_PASSWORD_FILE: passwordFile,
              },
              stdio: "pipe",
            },
          );
          child.on("error", fail);
          child.on("close", ok);
        });
      const attempts = await Promise.all([invoke(), invoke()]);
      assert.deepEqual(attempts.sort(), [0, 1]);
      assert.equal(await db.user.count(), 1);
      assert.equal(await db.organization.count(), 1);
      assert.equal(await db.client.count(), 0);
      const membership = await db.membership.findFirstOrThrow();
      assert.equal(membership.role, "OWNER");
      assert.equal(membership.clientId, null);
      await assertRuntimeRole(runtime);
      await login(
        runtime,
        inputs.BOOTSTRAP_EMAIL.toLowerCase(),
        inputs.BOOTSTRAP_PASSWORD,
      );
      const before = await fingerprint(db);
      await assert.rejects(
        bootstrap({
          ...inputs,
          BOOTSTRAP_PASSWORD: randomBytes(24).toString("hex"),
        }),
      );
      assert.equal(await fingerprint(db), before);
      break;
    }
    case "restore": {
      const restored = database(migrationURL, "restore_check");
      const runtime = database(runtimeURL, "restore_check");
      assert.equal(await fingerprint(restored), await fingerprint(source));
      await assertRuntimeRole(runtime);
      const rls = await restored.$queryRaw<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid IN ('"Client"'::regclass, '"Brand"'::regclass, '"Organization"'::regclass, '"Membership"'::regclass, '"AuditLog"'::regclass)`;
      assert.equal(rls.length, 5);
      assert.ok(rls.every((r) => r.relrowsecurity && r.relforcerowsecurity));
      assert.equal(await runtime.client.count(), 0);
      assert.equal(await runtime.brand.count(), 0);
      for (const suffix of ["a", "b"]) {
        const rows = await asActor(runtime, `admin-${suffix}`, (tx) =>
          tx.client.findMany(),
        );
        assert.ok(
          rows.length > 0 &&
            rows.every((r) => r.organizationId === `org-${suffix}`),
        );
      }
      await assert.rejects(
        asActor(runtime, "admin-a", (tx) =>
          tx.client.create({
            data: {
              organizationId: "org-b",
              name: "Forbidden",
              slug: "forbidden",
            },
          }),
        ),
      );
      await restored.rateLimit.deleteMany();
      await login(
        runtime,
        "admin-a@socialflow.test",
        process.env.DEV_SEED_PASSWORD!,
      );
      break;
    }
    default:
      throw new Error("Unknown operation verification");
  }
  console.info(
    JSON.stringify({
      event: "operations_verification_passed",
      check: process.argv[2],
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      event: "operations_verification_failed",
      check: process.argv[2],
    }),
  );
  process.exitCode = 1;
} finally {
  await Promise.all(clients.map((db) => db.$disconnect()));
}
