import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase, asActor } from "../../packages/db/src/index.js";
import { Redis } from "ioredis";
import { Queue } from "bullmq";

const db = createDatabase(process.env.DATABASE_URL!);
const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);
const base = "http://127.0.0.1:53001";
const origin = process.env.APP_URL!;
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
const queue = new Queue("diagnostics", { connection: redis });
const password = process.env.DEV_SEED_PASSWORD!;
async function request(
  path: string,
  cookie = "",
  method = "GET",
  data?: unknown,
  requestOrigin = origin,
) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      origin: requestOrigin,
      "content-type": "application/json",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
async function login(id: string) {
  const res = await request("/api/auth/sign-in/email", "", "POST", {
    email: `${id}@socialflow.test`,
    password,
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
}
beforeAll(async () => {
  await db.$connect();
  expect((await request("/health/ready")).status).toBe(200);
});
beforeEach(async () => {
  await migration.rateLimit.deleteMany();
});
afterAll(async () => {
  await queue.close();
  redis.disconnect();
  await db.$disconnect();
  await migration.$disconnect();
});

describe("real PostgreSQL runtime isolation", () => {
  it("runtime cannot bypass RLS or own tables", async () => {
    const roles = await db.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean; current_user: string }[]
    >`SELECT rolsuper, rolbypassrls, current_user FROM pg_roles WHERE rolname = current_user`;
    expect(roles[0]).toMatchObject({
      current_user: "socialflow_runtime",
      rolsuper: false,
      rolbypassrls: false,
    });
    const owners = await db.$queryRaw<
      { tableowner: string }[]
    >`SELECT tableowner FROM pg_tables WHERE tablename = 'Client'`;
    expect(owners[0]?.tableowner).not.toBe("socialflow_runtime");
    expect(await db.client.findMany()).toEqual([]);
  });
  it("A cannot read, insert, update, delete B even in direct SQL", async () => {
    await asActor(db, "admin-a", async (tx) => {
      expect(
        await tx.client.findMany({ where: { organizationId: "org-b" } }),
      ).toEqual([]);
      expect(
        (
          await tx.client.updateMany({
            where: { id: "client-b" },
            data: { name: "Invaded" },
          })
        ).count,
      ).toBe(0);
    });
    await expect(
      asActor(db, "admin-a", (tx) =>
        tx.client.create({
          data: {
            organizationId: "org-b",
            name: "Invaded",
            slug: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asActor(db, "admin-a", (tx) =>
        tx.client.delete({ where: { id: "client-b" } }),
      ),
    ).rejects.toThrow();
    await expect(
      asActor(db, "viewer-a", (tx) =>
        tx.client.update({
          where: { id: "client-a" },
          data: { name: "Invaded" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asActor(db, "editor-a", (tx) =>
        tx.client.update({
          where: { id: "client-a" },
          data: { active: false },
        }),
      ),
    ).rejects.toThrow();
  });
  it("alternating concurrent actors never retain pooled context", async () => {
    await Promise.all(
      Array.from({ length: 30 }, async (_, index) => {
        const suffix = index % 2 ? "a" : "b";
        const rows = await asActor(db, `admin-${suffix}`, (tx) =>
          tx.client.findMany(),
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.organizationId === `org-${suffix}`)).toBe(
          true,
        );
      }),
    );
    expect(await db.client.count()).toBe(0);
  });
  it("rejects cross-organization membership, duplicate nullable scope and invalid role scope", async () => {
    await expect(
      migration.membership.create({
        data: {
          userId: "viewer-a",
          organizationId: "org-a",
          clientId: "client-b",
          role: "CLIENT_VIEWER",
        },
      }),
    ).rejects.toThrow();
    await expect(
      migration.membership.create({
        data: { userId: "admin-a", organizationId: "org-a", role: "ADMIN" },
      }),
    ).rejects.toThrow();
    await expect(
      migration.membership.create({
        data: {
          userId: "viewer-a",
          organizationId: "org-b",
          role: "CLIENT_VIEWER",
        },
      }),
    ).rejects.toThrow();
    await expect(
      asActor(db, "admin-a", (tx) =>
        tx.membership.update({
          where: { id: "membership-viewer-a" },
          data: { role: "ADMIN" },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("HTTP authentication and authorization", () => {
  it("invalid and unknown identities have identical public errors; no public signup", async () => {
    const bad = await request("/api/auth/sign-in/email", "", "POST", {
      email: "admin-a@socialflow.test",
      password: "incorrect-password",
    });
    const missing = await request("/api/auth/sign-in/email", "", "POST", {
      email: "missing@socialflow.test",
      password: "incorrect-password",
    });
    expect(bad.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(await bad.json()).toEqual(await missing.json());
    expect(
      (await request("/api/auth/sign-up/email", "", "POST", {})).status,
    ).toBe(404);
    expect((await request("/api/me")).status).toBe(401);
  });
  it("same client URLs enforce organization and client memberships for all profiles", async () => {
    for (const id of [
      "admin-a",
      "editor-a",
      "viewer-a",
      "approver-a",
      "owner-a",
    ]) {
      await migration.rateLimit.deleteMany();
      const cookie = await login(id);
      expect(
        (await request("/api/organizations/org-a/clients/client-a", cookie))
          .status,
      ).toBe(200);
      expect(
        (await request("/api/organizations/org-b/clients/client-b", cookie))
          .status,
      ).toBe(404);
      expect(
        (await request("/api/organizations/org-a/clients/client-b", cookie))
          .status,
      ).toBe(404);
      expect(
        (
          await request("/api/organizations/org-b/clients", cookie, "POST", {
            name: "Invaded",
            slug: randomUUID(),
          })
        ).status,
      ).toBe(404);
    }
    const other = await login("admin-b");
    expect(
      (await request("/api/organizations/org-a/clients/client-a", other))
        .status,
    ).toBe(404);
  });
  it("admin creates; viewer and approver cannot write; editor can rename only assigned client", async () => {
    const admin = await login("admin-a");
    const viewer = await login("viewer-a");
    const editor = await login("editor-a");
    const approver = await login("approver-a");
    const path = "/api/organizations/org-a/clients";
    const created = await request(path, admin, "POST", {
      name: "Integration Client",
      slug: randomUUID(),
    });
    expect(created.status).toBe(201);
    const client = await created.json();
    expect((await request(`${path}/${client.id}`, viewer)).status).toBe(404);
    for (const cookie of [viewer, approver, editor])
      expect(
        (
          await request(path, cookie, "POST", {
            name: "Forbidden",
            slug: randomUUID(),
          })
        ).status,
      ).toBe(403);
    expect(
      (
        await request(`${path}/client-a`, viewer, "PATCH", {
          name: "Forbidden",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`${path}/client-a`, approver, "PATCH", {
          name: "Forbidden",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`${path}/client-a`, editor, "PATCH", {
          name: "Café Central",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`${path}/${client.id}`, editor, "PATCH", {
          name: "Forbidden",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(path, admin, "POST", {
          name: "Escalate",
          slug: "escalate",
          role: "OWNER",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`${path}/${client.id}`, admin, "PATCH", {
          organizationId: "org-b",
          name: "Transfer",
        })
      ).status,
    ).toBe(400);
    expect(
      (await request(`${path}/${client.id}`, admin, "DELETE")).status,
    ).toBe(200);
  });
  it("enforces origin and missing-origin CSRF protection", async () => {
    const cookie = await login("admin-a");
    expect(
      (
        await request(
          "/api/organizations/org-a/clients",
          cookie,
          "POST",
          { name: "Bad Origin", slug: "bad" },
          "https://evil.test",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "/api/auth/sign-in/email",
          "",
          "POST",
          { email: "admin-a@socialflow.test", password },
          "https://evil.test",
        )
      ).status,
    ).toBe(403);
    const missing = await fetch(`${base}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie },
    });
    expect(missing.status).toBe(403);
  });
  it("logout, database revocation and expiry take effect immediately", async () => {
    const cookie = await login("admin-a");
    expect(
      (await request("/api/auth/sign-out", cookie, "POST", {})).status,
    ).toBe(200);
    expect((await request("/api/me", cookie)).status).toBe(401);
    const revoked = await login("admin-a");
    await migration.session.deleteMany({ where: { userId: "admin-a" } });
    expect((await request("/api/me", revoked)).status).toBe(401);
    const expired = await login("admin-a");
    await migration.session.updateMany({
      where: { userId: "admin-a" },
      data: { expiresAt: new Date(0) },
    });
    expect((await request("/api/me", expired)).status).toBe(401);
  });
  it("disabled users and revoked memberships immediately lose access", async () => {
    const cookie = await login("viewer-a");
    await migration.user.update({
      where: { id: "viewer-a" },
      data: { active: false },
    });
    try {
      expect((await request("/api/me", cookie)).status).toBe(401);
    } finally {
      await migration.user.update({
        where: { id: "viewer-a" },
        data: { active: true },
      });
    }
    await migration.membership.update({
      where: { id: "membership-viewer-a" },
      data: { active: false },
    });
    try {
      expect(
        (await request("/api/organizations/org-a/clients/client-a", cookie))
          .status,
      ).toBe(404);
    } finally {
      await migration.membership.update({
        where: { id: "membership-viewer-a" },
        data: { active: true },
      });
    }
  });
  it("limits login attempts even when forwarded IP is forged", async () => {
    for (let i = 0; i < 5; i++)
      await request("/api/auth/sign-in/email", "", "POST", {
        email: "nobody@socialflow.test",
        password: "incorrect-password",
      });
    const res = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-forwarded-for": "1.2.3.4",
      },
      body: JSON.stringify({
        email: "nobody@socialflow.test",
        password: "incorrect-password",
      }),
    });
    expect(res.status).toBe(429);
  });
  it("worker processes a real authorized diagnostic and rejects forged tenant", async () => {
    const cookie = await login("admin-a");
    const res = await request(
      "/api/organizations/org-a/diagnostics",
      cookie,
      "POST",
      {},
    );
    expect(res.status).toBe(202);
    const { jobId } = await res.json();
    await expect
      .poll(async () => (await queue.getJob(jobId))?.getState(), {
        timeout: 10000,
      })
      .toBe("completed");
    const forged = await queue.add("diagnostic", {
      userId: "viewer-a",
      organizationId: "org-b",
    });
    await expect
      .poll(() => forged.getState(), { timeout: 10000 })
      .toBe("failed");
    expect(await redis.ping()).toBe("PONG");
  });
});
