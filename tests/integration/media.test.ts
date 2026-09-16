import sharp from "sharp";
import { beforeEach, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createDatabase, asActor } from "@socialflow/db";
import { createAuth } from "../../apps/api/src/auth.js";

const requireApi = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
);
const express = requireApi("express");
const { fromNodeHeaders } = await import(
  pathToFileURL(requireApi.resolve("better-auth/node")).href
);
import {
  registerMedia,
  MediaError,
  type MediaStorage,
  type Scope,
} from "../../apps/api/src/media.js";

import type { ServerResponse } from "node:http";

type AppRequest = Parameters<Scope>[0];
import { mediaStorage } from "../../apps/api/src/media-storage.js";
import { readConfig } from "../../packages/config/src/index.js";
import { isAdmin } from "../../packages/contracts/src/index.js";
import type { AddressInfo } from "node:net";

const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);
const runtime = createDatabase(process.env.DATABASE_URL!);
const base = `http://127.0.0.1:${process.env.TEST_API_PORT ?? 53001}`;
const root = "/api/organizations/org-a/clients/client-a/media";
const getRealStorage = () => {
  const store = mediaStorage(process.env);
  if (!store)
    throw new Error("mediaStorage returned null; check MEDIA_S3_* env vars");
  return store;
};
const config = readConfig(process.env);
const auth = createAuth(runtime, config);

async function actor(req: AppRequest) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session) throw new MediaError(401, "Sessão expirada. Entre novamente.");
  const user = await runtime.user.findFirst({
    where: { id: session.user.id, active: true },
    select: { id: true, name: true, email: true },
  });
  if (!user) throw new MediaError(401, "Sessão expirada. Entre novamente.");
  return user;
}

const defaultScoped: Scope = async (req, organizationId, fn) => {
  const user = await actor(req);
  return asActor(runtime, user.id, async (tx) => {
    const memberships = await tx.membership.findMany({
      where: {
        userId: user.id,
        organizationId,
        active: true,
        organization: { active: true },
      },
    });
    if (!memberships.length)
      throw new MediaError(404, "Organização não encontrada.");
    return fn(
      tx,
      user.id,
      memberships.some((m) => isAdmin(m.role) && m.clientId === null),
    );
  });
};

async function createMediaHarness(options?: {
  storage?: MediaStorage | null;
  scopedOverride?: (origScoped: Scope) => Scope;
}) {
  const app = express();
  app.use((_req: AppRequest, res: ServerResponse, next: () => void) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    next();
  });
  app.use(express.json({ limit: "16kb" }));

  const scoped = options?.scopedOverride
    ? options.scopedOverride(defaultScoped)
    : defaultScoped;

  const closeMedia = registerMedia(app, scoped, {
    storage:
      options?.storage !== undefined ? options.storage : getRealStorage(),
  });

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const harnessBase = `http://127.0.0.1:${port}`;

  return {
    base: harnessBase,
    close: async () => {
      closeMedia();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function reqOn(
  serverBase: string,
  path: string,
  cookie = "",
  method = "GET",
  data?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return fetch(serverBase + path, {
    method,
    headers: {
      cookie,
      origin: process.env.APP_URL!,
      "Content-Type": Buffer.isBuffer(data)
        ? "application/octet-stream"
        : "application/json",
      ...extraHeaders,
    },
    body:
      data === undefined
        ? undefined
        : Buffer.isBuffer(data)
          ? new Uint8Array(data).buffer
          : JSON.stringify(data),
  });
}

async function reserveOn(serverBase: string, cookie: string) {
  const r = await reqOn(serverBase, root, cookie, "POST", {
    name: `Imagem ${randomUUID()}`,
  });
  expect(r.status).toBe(201);
  return (await r.json()).id as string;
}
const png = await sharp({
  create: { width: 16, height: 12, channels: 3, background: "#285844" },
})
  .png()
  .toBuffer();
async function req(
  path: string,
  cookie = "",
  method = "GET",
  data?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return fetch(base + path, {
    method,
    headers: {
      cookie,
      origin: process.env.APP_URL!,
      "Content-Type": Buffer.isBuffer(data)
        ? "application/octet-stream"
        : "application/json",
      ...extraHeaders,
    },
    body:
      data === undefined
        ? undefined
        : Buffer.isBuffer(data)
          ? new Uint8Array(data).buffer
          : JSON.stringify(data),
  });
}
async function login(id: string) {
  const r = await req("/api/auth/sign-in/email", "", "POST", {
    email: `${id}@socialflow.test`,
    password: process.env.DEV_SEED_PASSWORD,
  });
  expect(r.status).toBe(200);
  return r.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
}
async function reserve(cookie: string) {
  const r = await req(root, cookie, "POST", { name: `Imagem ${randomUUID()}` });
  expect(r.status).toBe(201);
  return (await r.json()).id as string;
}
beforeEach(async () => {
  await migration.rateLimit.deleteMany();
  await migration.mediaAsset.deleteMany({
    where: {
      status: { in: ["pending", "uploading"] },
    },
  });
});
afterAll(async () => {
  await migration.$disconnect();
  await runtime.$disconnect();
});
describe("private media", () => {
  it("blocks same-organization foreign client and invalid compound brand FK", async () => {
    const cookie = await login("editor-a");
    const client = await migration.client.create({
      data: {
        organizationId: "org-a",
        name: "Outra conta",
        slug: randomUUID(),
      },
    });
    const brand = await migration.brand.create({
      data: {
        organizationId: "org-a",
        clientId: client.id,
        name: "Outra marca",
      },
    });
    try {
      expect(
        (
          await req(
            `/api/organizations/org-a/clients/${client.id}/media`,
            cookie,
          )
        ).status,
      ).toBe(404);
      const id = randomUUID();
      await expect(
        asActor(runtime, "admin-a", (tx) =>
          tx.mediaAsset.create({
            data: {
              id,
              organizationId: "org-a",
              clientId: "client-a",
              brandId: brand.id,
              name: "Escopo inválido",
              storageKey: `media/org-a/client-a/${id}`,
            },
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await migration.brand.delete({ where: { id: brand.id } });
      await migration.client.delete({ where: { id: client.id } });
    }
  });
  it("allows only one concurrent confirmation and one created audit", async () => {
    const cookie = await login("admin-a"),
      id = await reserve(cookie);
    const responses = await Promise.all([
      req(`${root}/${id}/content`, cookie, "PUT", png),
      req(`${root}/${id}/content`, cookie, "PUT", png),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await migration.auditLog.count({
        where: { entityId: id, action: "media.created" },
      }),
    ).toBe(1);
  });
  it("uploads, serves, edits and archives with immutable bytes and audit", async () => {
    const cookie = await login("admin-a"),
      id = await reserve(cookie);
    const uploaded = await req(`${root}/${id}/content`, cookie, "PUT", png);
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const content = await req(`${root}/${id}/content`, cookie);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toContain("image/png");
    expect(
      (await req(`${root}/${id}/content`, cookie, "PUT", png)).status,
    ).toBe(409);
    expect(
      (
        await req(`${root}/${id}`, cookie, "PATCH", {
          name: "Nova imagem",
          description: "Texto",
        })
      ).status,
    ).toBe(200);
    expect((await req(`${root}/${id}`, cookie, "DELETE")).status).toBe(200);
    expect((await req(`${root}/${id}/content`, cookie)).status).toBe(404);
    expect(
      await migration.auditLog.count({
        where: { entityId: id, action: "media.created" },
      }),
    ).toBe(1);
  });
  it("rejects malformed and oversized images without publishing", async () => {
    const cookie = await login("admin-a"),
      id = await reserve(cookie);
    expect(
      (await req(`${root}/${id}/content`, cookie, "PUT", Buffer.from("<svg/>")))
        .status,
    ).toBe(400);
    expect(
      (
        await req(
          `${root}/${id}/content`,
          cookie,
          "PUT",
          Buffer.alloc(10 * 1024 * 1024 + 1),
        )
      ).status,
    ).toBe(413);
    expect((await req(`${root}/${id}/content`, cookie)).status).toBe(404);
  });
  it("enforces roles and cross-organization HTTP IDOR", async () => {
    const admin = await login("admin-a"),
      id = await reserve(admin);
    expect((await req(`${root}/${id}/content`, admin, "PUT", png)).status).toBe(
      201,
    );
    for (const role of ["viewer-a", "approver-a"]) {
      const cookie = await login(role);
      expect((await req(`${root}/${id}/content`, cookie)).status).toBe(200);
      expect(
        (await req(root, cookie, "POST", { name: "Proibido" })).status,
      ).toBe(403);
    }
    const editor = await login("editor-a");
    expect((await req(`${root}/${id}`, editor, "DELETE")).status).toBe(403);
    const other = await login("admin-b");
    expect((await req(`${root}/${id}/content`, other)).status).toBe(404);
    expect(
      (
        await req(
          `/api/organizations/org-b/clients/client-b/media/${id}/content`,
          other,
        )
      ).status,
    ).toBe(404);
  });
  it("rejects foreign brand and enforces SQL scope, RLS and archive privileges", async () => {
    const cookie = await login("admin-a");
    const b = await migration.brand.create({
      data: { organizationId: "org-b", clientId: "client-b", name: "Other" },
    });
    try {
      expect(
        (
          await req(root, cookie, "POST", {
            name: "Invalid association",
            brandId: b.id,
          })
        ).status,
      ).toBe(404);
    } finally {
      await migration.brand.delete({ where: { id: b.id } });
    }
    const id = await reserve(cookie);
    await expect(
      asActor(runtime, "admin-a", (tx) =>
        tx.mediaAsset.update({ where: { id }, data: { clientId: "client-b" } }),
      ),
    ).rejects.toThrow();
    await expect(
      asActor(runtime, "editor-a", (tx) =>
        tx.mediaAsset.update({ where: { id }, data: { archived: true } }),
      ),
    ).rejects.toThrow();
    expect(
      await asActor(runtime, "admin-b", (tx) =>
        tx.mediaAsset.count({ where: { id } }),
      ),
    ).toBe(0);
    const flags = await migration.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='"MediaAsset"'::regclass`;
    expect(flags[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
  });
  it("blocks the same session after membership revocation and inactive scope", async () => {
    const admin = await login("admin-a"),
      editor = await login("editor-a"),
      id = await reserve(admin);
    expect((await req(`${root}/${id}/content`, admin, "PUT", png)).status).toBe(
      201,
    );
    await migration.membership.update({
      where: { id: "membership-editor-a" },
      data: { active: false },
    });
    try {
      expect((await req(`${root}/${id}/content`, editor)).status).toBe(404);
    } finally {
      await migration.membership.update({
        where: { id: "membership-editor-a" },
        data: { active: true },
      });
    }
    for (const entity of ["client", "organization", "user"] as const) {
      const entityId =
        entity === "client"
          ? "client-a"
          : entity === "organization"
            ? "org-a"
            : "editor-a";
      const setActive = (active: boolean) => {
        const args = { where: { id: entityId }, data: { active } };
        if (entity === "client") return migration.client.update(args);
        if (entity === "organization")
          return migration.organization.update(args);
        return migration.user.update(args);
      };
      await setActive(false);
      try {
        expect((await req(`${root}/${id}/content`, editor)).status).toBe(
          entity === "user" ? 401 : 404,
        );
      } finally {
        await setActive(true);
      }
    }
  });

  it("preserves CSP, nosniff and cache-control headers through web frontend proxy URL", async () => {
    const cookie = await login("admin-a"),
      id = await reserve(cookie);
    const uploadRes = await req(`${root}/${id}/content`, cookie, "PUT", png);
    expect(uploadRes.status).toBe(201);

    const webUrl = `${process.env.APP_URL ?? "http://localhost:3000"}${root}/${id}/content`;
    const response = await fetch(webUrl, {
      headers: {
        cookie,
        origin: process.env.APP_URL!,
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
  });

  it("enforces explicit client membership for non-administrators on read and write", async () => {
    const cookie = await login("editor-a");
    const client = await migration.client.create({
      data: {
        organizationId: "org-a",
        name: "Cliente Sem Vínculo",
        slug: randomUUID(),
      },
    });

    try {
      const listRes = await req(
        `/api/organizations/org-a/clients/${client.id}/media`,
        cookie,
      );
      expect(listRes.status).toBe(404);

      const createRes = await req(
        `/api/organizations/org-a/clients/${client.id}/media`,
        cookie,
        "POST",
        { name: "Proibido" },
      );
      expect(createRes.status).toBe(404);
    } finally {
      await migration.client.delete({ where: { id: client.id } });
    }
  });

  it("handles expired reservations and excludes old reservations from recent count", async () => {
    const cookie = await login("admin-a");

    const expiredId = await reserve(cookie);
    await migration.mediaAsset.update({
      where: { id: expiredId },
      data: { createdAt: new Date(Date.now() - 7200000) },
    });

    const uploadExpired = await req(
      `${root}/${expiredId}/content`,
      cookie,
      "PUT",
      png,
    );
    expect(uploadExpired.status).toBe(409);

    const expiredIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const eid = randomUUID();
      await migration.mediaAsset.create({
        data: {
          id: eid,
          organizationId: "org-a",
          clientId: "client-a",
          name: `Antiga ${i}`,
          storageKey: `media/org-a/client-a/${eid}`,
          status: "pending",
          createdAt: new Date(Date.now() - 7200000),
        },
      });
      expiredIds.push(eid);
    }

    try {
      const newRes = await req(root, cookie, "POST", { name: "Nova Recente" });
      expect(newRes.status).toBe(201);
      const newId = (await newRes.json()).id as string;
      await migration.mediaAsset.delete({ where: { id: newId } });
    } finally {
      await migration.mediaAsset.deleteMany({
        where: { id: { in: expiredIds } },
      });
      await migration.mediaAsset.delete({ where: { id: expiredId } });
    }
  });

  it("enforces pending reservations limit and rejects with 429 when recent limit is reached", async () => {
    const cookie = await login("admin-a");
    const activeIds: string[] = [];

    try {
      const currentCount = await migration.mediaAsset.count({
        where: {
          organizationId: "org-a",
          clientId: "client-a",
          status: { in: ["pending", "uploading"] },
          createdAt: { gt: new Date(Date.now() - 3600000) },
        },
      });

      for (let i = currentCount; i < 20; i++) {
        const id = randomUUID();
        await migration.mediaAsset.create({
          data: {
            id,
            organizationId: "org-a",
            clientId: "client-a",
            name: `Pendente ${i}`,
            storageKey: `media/org-a/client-a/${id}`,
            status: "pending",
            createdAt: new Date(),
          },
        });
        activeIds.push(id);
      }

      const overLimit = await req(root, cookie, "POST", { name: "Excessiva" });
      expect(overLimit.status).toBe(429);
    } finally {
      if (activeIds.length) {
        await migration.mediaAsset.deleteMany({
          where: { id: { in: activeIds } },
        });
      }
    }
  });

  it("enforces concurrent uploads limit of max 2 simultaneous uploads", async () => {
    const cookie = await login("admin-a");
    const id1 = await reserve(cookie);
    const id2 = await reserve(cookie);
    const id3 = await reserve(cookie);

    const [r1, r2, r3] = await Promise.all([
      req(`${root}/${id1}/content`, cookie, "PUT", png),
      req(`${root}/${id2}/content`, cookie, "PUT", png),
      req(`${root}/${id3}/content`, cookie, "PUT", png),
    ]);

    const statuses = [r1.status, r2.status, r3.status];
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 201 || s === 429)).toBe(true);
  });

  it("handles failed upload without marking as ready and allows retry with distinct key and audit", async () => {
    const cookie = await login("admin-a");
    const failId = await reserve(cookie);

    const failRes = await req(
      `${root}/${failId}/content`,
      cookie,
      "PUT",
      Buffer.from("invalid-binary-data"),
    );
    expect(failRes.status).toBe(400);

    const failedAsset = await migration.mediaAsset.findUniqueOrThrow({
      where: { id: failId },
    });
    expect(failedAsset.status).not.toBe("ready");

    const listRes = await req(root, cookie);
    const listData = (await listRes.json()) as { items: { id: string }[] };
    expect(listData.items.some((i) => i.id === failId)).toBe(false);

    const contentRes = await req(`${root}/${failId}/content`, cookie);
    expect(contentRes.status).toBe(404);

    const failAudits = await migration.auditLog.count({
      where: { entityId: failId, action: "media.created" },
    });
    expect(failAudits).toBe(0);

    const retryId = await reserve(cookie);
    expect(retryId).not.toBe(failId);

    const retryRes = await req(
      `${root}/${retryId}/content`,
      cookie,
      "PUT",
      png,
    );
    expect(retryRes.status).toBe(201);

    const retryAudits = await migration.auditLog.count({
      where: { entityId: retryId, action: "media.created" },
    });
    expect(retryAudits).toBe(1);

    const retryAsset = await migration.mediaAsset.findUniqueOrThrow({
      where: { id: retryId },
    });
    expect(retryAsset.storageKey).toBe(`media/org-a/client-a/${retryId}`);
    expect(retryAsset.storageKey).not.toBe(failedAsset.storageKey);
  });

  it("ignores all legacy test headers on the normal handler without causing failures or modifying permissions", async () => {
    const cookie = await login("admin-a");
    const id = await reserve(cookie);

    const res = await req(`${root}/${id}/content`, cookie, "PUT", png, {
      "x-test-fail-storage": "true",
      "x-test-fail-commit": "true",
      "x-test-fail-recovery": "true",
      "x-test-revoke-membership": "true",
      "x-correlation-id": "client-correlation-header",
    });

    // O handler normal ignora completamente headers x-test-* e processa normalmente
    expect(res.status).toBe(201);

    const asset = await migration.mediaAsset.findUniqueOrThrow({
      where: { id },
    });
    expect(asset.status).toBe("ready");

    const contentRes = await req(`${root}/${id}/content`, cookie);
    expect(contentRes.status).toBe(200);

    expect(
      await migration.auditLog.count({
        where: { entityId: id, action: "media.created" },
      }),
    ).toBe(1);
    expect(
      await migration.auditLog.count({
        where: { entityId: id, action: "media.upload_failed" },
      }),
    ).toBe(0);
  });

  it("transitions to failed status and records media.upload_failed when storage.put fails via replaceable storage dependency", async () => {
    const realStore = getRealStorage();
    const failingStorage: MediaStorage = {
      put: async () => {
        throw new Error(
          "Simulated storage write failure via injected dependency",
        );
      },
      get: (key: string) => realStore.get(key),
      close: () => realStore.close?.(),
    };
    const harness = await createMediaHarness({ storage: failingStorage });
    try {
      const cookie = await login("admin-a");
      const id = await reserveOn(harness.base, cookie);

      const failRes = await reqOn(
        harness.base,
        `${root}/${id}/content`,
        cookie,
        "PUT",
        png,
        { "x-correlation-id": "corr-storage-fail" },
      );
      expect(failRes.status).toBe(503);

      const asset = await migration.mediaAsset.findUniqueOrThrow({
        where: { id },
      });
      expect(asset.status).toBe("failed");

      const listRes = await reqOn(harness.base, root, cookie);
      const list = (await listRes.json()) as { items: { id: string }[] };
      expect(list.items.some((i) => i.id === id)).toBe(false);

      const contentRes = await reqOn(
        harness.base,
        `${root}/${id}/content`,
        cookie,
      );
      expect(contentRes.status).toBe(404);

      expect(
        await migration.auditLog.count({
          where: { entityId: id, action: "media.created" },
        }),
      ).toBe(0);
      expect(
        await migration.auditLog.count({
          where: { entityId: id, action: "media.upload_failed" },
        }),
      ).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it("preserves authorization error and prevents privilege elevation when access is revoked in PostgreSQL between real storage write and commit", async () => {
    const realStore = getRealStorage();
    let onAfterStoragePut: (() => Promise<void>) | undefined;
    const syncStorage: MediaStorage = {
      async put(key, data, mimeType) {
        // 1. Gravação real no MinIO:
        await realStore.put(key, data, mimeType);
        // 2. Pause determinístico antes da finalização:
        if (onAfterStoragePut) {
          await onAfterStoragePut();
        }
      },
      get: (key: string) => realStore.get(key),
      close: () => realStore.close?.(),
    };

    const harness = await createMediaHarness({ storage: syncStorage });
    try {
      const cookie = await login("editor-a");
      const id = await reserveOn(harness.base, cookie);

      // Define ponto de sincronização determinístico:
      // Revoga de verdade o vínculo no PostgreSQL pela conexão administrativa exclusiva do teste
      onAfterStoragePut = async () => {
        await migration.membership.update({
          where: { id: "membership-editor-a" },
          data: { active: false },
        });
      };

      // Retoma o fluxo, deixando access() e as transações reais executarem
      const res = await reqOn(
        harness.base,
        `${root}/${id}/content`,
        cookie,
        "PUT",
        png,
        { "x-correlation-id": "corr-real-revocation-sync" },
      );
      // Resposta de autorização original esperada
      expect(res.status).toBe(404);

      const asset = await migration.mediaAsset.findUniqueOrThrow({
        where: { id },
      });
      // Asset permanece em uploading na infraestrutura real
      expect(asset.status).toBe("uploading");

      // Ausência de media.created
      expect(
        await migration.auditLog.count({
          where: { entityId: id, action: "media.created" },
        }),
      ).toBe(0);
      // Ausência de elevação de privilégio (não gerou media.upload_failed porque actor perdeu permissão)
      expect(
        await migration.auditLog.count({
          where: { entityId: id, action: "media.upload_failed" },
        }),
      ).toBe(0);

      // Conteúdo permanece inacessível
      const adminCookie = await login("admin-a");
      const contentRes = await reqOn(
        harness.base,
        `${root}/${id}/content`,
        adminCookie,
      );
      expect(contentRes.status).toBe(404);
    } finally {
      // Restaura o estado da fixture no PostgreSQL ao terminar
      await migration.membership.update({
        where: { id: "membership-editor-a" },
        data: { active: true },
      });
      await harness.close();
    }
  });

  it("preserves uploading state without publishing when persistence dependency fails during commit and recovery", async () => {
    let interceptPut = false;
    let callsDuringPut = 0;
    const scopedOverride = (origScoped: Scope): Scope => {
      return async (req, org, fn) => {
        if (interceptPut) {
          callsDuringPut++;
          // Chamadas 1 e 2 passam: checagem de pending e transição para uploading.
          // Falha a partir da chamada 3: commit de finalização e tentativa de recovery.
          if (callsDuringPut > 2) {
            throw new Error(
              "Simulated database connection failure via persistence dependency",
            );
          }
        }
        return origScoped(req, org, fn);
      };
    };

    const harness = await createMediaHarness({
      storage: getRealStorage(),
      scopedOverride,
    });
    try {
      const cookie = await login("admin-a");
      const id = await reserveOn(harness.base, cookie);

      // Simula falha na camada de persistência a partir do commit e tentativa de recovery
      interceptPut = true;

      const res = await reqOn(
        harness.base,
        `${root}/${id}/content`,
        cookie,
        "PUT",
        png,
        { "x-correlation-id": "corr-persistence-fail" },
      );
      expect(res.status).toBe(503);
      interceptPut = false;

      const asset = await migration.mediaAsset.findUniqueOrThrow({
        where: { id },
      });
      expect(asset.status).toBe("uploading");

      expect(
        await migration.auditLog.count({
          where: { entityId: id, action: "media.created" },
        }),
      ).toBe(0);
      expect(
        await migration.auditLog.count({
          where: { entityId: id, action: "media.upload_failed" },
        }),
      ).toBe(0);

      const contentRes = await reqOn(
        harness.base,
        `${root}/${id}/content`,
        cookie,
      );
      expect(contentRes.status).toBe(404);
    } finally {
      await harness.close();
    }
  });
});
