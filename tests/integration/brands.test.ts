import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  asActor,
  assertRuntimeRole,
} from "../../packages/db/src/index.js";
import { Redis } from "ioredis";

const db = createDatabase(process.env.DATABASE_URL!);
const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);
const base = `http://127.0.0.1:${process.env.TEST_API_PORT ?? 53001}`;
const origin = process.env.APP_URL!;
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
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
  redis.disconnect();
  await db.$disconnect();
  await migration.$disconnect();
});

describe("PostgreSQL runtime RLS and isolation for Brand", () => {
  it("enforces RLS and FORCE RLS on Brand with non-privileged runtime role", async () => {
    await assertRuntimeRole(db);
    const rls = await migration.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"Brand"'::regclass`;
    expect(rls[0]).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
    const owners = await db.$queryRaw<
      { tableowner: string }[]
    >`SELECT tableowner FROM pg_tables WHERE tablename = 'Brand'`;
    expect(owners[0]?.tableowner).not.toBe("socialflow_runtime");
  });

  it("cross-organization isolation: org-a cannot read, insert, or update org-b brands", async () => {
    const brandB = await migration.brand.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        name: `Brand B ${randomUUID()}`,
      },
    });

    try {
      await asActor(db, "admin-a", async (tx) => {
        const found = await tx.brand.findMany({
          where: { organizationId: "org-b" },
        });
        expect(found).toEqual([]);
        const count = await tx.brand.updateMany({
          where: { id: brandB.id },
          data: { name: "Hacked" },
        });
        expect(count.count).toBe(0);
      });

      await expect(
        asActor(db, "admin-a", (tx) =>
          tx.brand.create({
            data: {
              organizationId: "org-b",
              clientId: "client-b",
              name: "Invader Brand",
            },
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await migration.brand.delete({ where: { id: brandB.id } });
    }
  });

  it("same-org cross-client isolation: editor-a cannot access client-a2 brands", async () => {
    const clientA2 = await migration.client.create({
      data: {
        organizationId: "org-a",
        name: "Cliente A2 Teste",
        slug: `client-a2-${Date.now()}`,
      },
    });
    const brandA2 = await migration.brand.create({
      data: {
        organizationId: "org-a",
        clientId: clientA2.id,
        name: `Brand A2 ${randomUUID()}`,
      },
    });

    try {
      await asActor(db, "editor-a", async (tx) => {
        const brands = await tx.brand.findMany({
          where: { clientId: clientA2.id },
        });
        expect(brands).toEqual([]);
        const updated = await tx.brand.updateMany({
          where: { id: brandA2.id },
          data: { name: "Illegal" },
        });
        expect(updated.count).toBe(0);
      });

      await expect(
        asActor(db, "editor-a", (tx) =>
          tx.brand.create({
            data: {
              organizationId: "org-a",
              clientId: clientA2.id,
              name: "Illegal Brand",
            },
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await migration.brand.deleteMany({ where: { clientId: clientA2.id } });
      await migration.client.delete({ where: { id: clientA2.id } });
    }
  });

  it("scope protection: prevents changing organizationId or clientId on Brand", async () => {
    const brand = await migration.brand.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        name: `Brand Scope Test ${randomUUID()}`,
      },
    });

    try {
      await expect(
        asActor(db, "admin-a", (tx) =>
          tx.brand.update({
            where: {
              organizationId_id: { organizationId: "org-a", id: brand.id },
            },
            data: { organizationId: "org-b" } as unknown as { name: string },
          }),
        ),
      ).rejects.toThrow();

      await expect(
        asActor(db, "admin-a", (tx) =>
          tx.brand.update({
            where: {
              organizationId_id: { organizationId: "org-a", id: brand.id },
            },
            data: { clientId: "client-b" } as unknown as { name: string },
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await migration.brand.delete({ where: { id: brand.id } });
    }
  });

  it("direct physical DELETE on Brand is denied for runtime role", async () => {
    const brand = await migration.brand.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        name: `Brand Delete Test ${randomUUID()}`,
      },
    });

    try {
      await expect(
        asActor(db, "admin-a", (tx) =>
          tx.brand.delete({
            where: {
              organizationId_id: { organizationId: "org-a", id: brand.id },
            },
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await migration.brand.delete({ where: { id: brand.id } });
    }
  });

  it("brand audit log creation, visibility, and immediate revocation", async () => {
    const brand = await asActor(db, "editor-a", (tx) =>
      tx.brand.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          name: `Audit Brand ${randomUUID()}`,
          description: "Audit description",
          targetAudience: "B2B",
          toneOfVoice: "Profissional",
        },
      }),
    );

    const audit = await asActor(db, "editor-a", (tx) =>
      tx.auditLog.create({
        data: {
          organizationId: "org-a",
          actorUserId: "editor-a",
          entityId: brand.id,
          action: "brand.created",
        },
      }),
    );

    try {
      await asActor(db, "editor-a", async (tx) => {
        const found = await tx.auditLog.findMany({ where: { id: audit.id } });
        expect(found.length).toBe(1);
        expect(found[0]?.entityId).toBe(brand.id);
      });

      await migration.membership.update({
        where: { id: "membership-editor-a" },
        data: { active: false },
      });

      await asActor(db, "editor-a", async (tx) => {
        expect(await tx.brand.findMany({ where: { id: brand.id } })).toEqual(
          [],
        );
        expect(await tx.auditLog.findMany({ where: { id: audit.id } })).toEqual(
          [],
        );
      });

      await migration.membership.update({
        where: { id: "membership-editor-a" },
        data: { active: true },
      });

      await asActor(db, "editor-a", async (tx) => {
        expect(
          (await tx.brand.findMany({ where: { id: brand.id } })).length,
        ).toBe(1);
        expect(
          (await tx.auditLog.findMany({ where: { id: audit.id } })).length,
        ).toBe(1);
      });
    } finally {
      await migration.membership.update({
        where: { id: "membership-editor-a" },
        data: { active: true },
      });
      await migration.auditLog.delete({ where: { id: audit.id } });
      await migration.brand.delete({ where: { id: brand.id } });
    }
  });

  it("regression: client audit logs remain functional and enforce revocation", async () => {
    const audit = await asActor(db, "editor-a", (tx) =>
      tx.auditLog.create({
        data: {
          organizationId: "org-a",
          actorUserId: "editor-a",
          entityId: "client-a",
          action: "client.updated",
        },
      }),
    );

    try {
      await asActor(db, "editor-a", async (tx) => {
        expect(
          (await tx.auditLog.findMany({ where: { id: audit.id } })).length,
        ).toBe(1);
      });

      await migration.membership.update({
        where: { id: "membership-editor-a" },
        data: { active: false },
      });

      await asActor(db, "editor-a", async (tx) => {
        expect(await tx.auditLog.findMany({ where: { id: audit.id } })).toEqual(
          [],
        );
      });
    } finally {
      await migration.membership.update({
        where: { id: "membership-editor-a" },
        data: { active: true },
      });
      await migration.auditLog.delete({ where: { id: audit.id } });
    }
  });
});

describe("HTTP Brand API permissions and validation across all 5 profiles", () => {
  it("OWNER and ADMIN have full read, create, and edit access", async () => {
    for (const roleId of ["owner-a", "admin-a"]) {
      await migration.rateLimit.deleteMany();
      const cookie = await login(roleId);

      const brandName = `Marca ${roleId} ${Date.now()}`;
      const createRes = await request(
        "/api/organizations/org-a/clients/client-a/brands",
        cookie,
        "POST",
        {
          name: brandName,
          description: "Descrição de teste",
          targetAudience: "Público tech",
          toneOfVoice: "Amigável",
        },
      );
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: string; name: string };
      expect(created.name).toBe(brandName);

      const listRes = await request(
        "/api/organizations/org-a/clients/client-a/brands",
        cookie,
      );
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { id: string }[];
      expect(list.some((b) => b.id === created.id)).toBe(true);

      const detailRes = await request(
        `/api/organizations/org-a/clients/client-a/brands/${created.id}`,
        cookie,
      );
      expect(detailRes.status).toBe(200);

      const updatedName = `${brandName} Editada`;
      const updateRes = await request(
        `/api/organizations/org-a/clients/client-a/brands/${created.id}`,
        cookie,
        "PATCH",
        {
          name: updatedName,
          description: "Nova descrição",
          targetAudience: "Novo público",
          toneOfVoice: "Formal",
        },
      );
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as {
        name: string;
        toneOfVoice: string;
      };
      expect(updated.name).toBe(updatedName);
      expect(updated.toneOfVoice).toBe("Formal");

      await migration.auditLog.deleteMany({ where: { entityId: created.id } });
      await migration.brand.delete({ where: { id: created.id } });
    }
  });

  it("EDITOR can read, create, and edit brands for assigned client, but is blocked on unassigned clients", async () => {
    const clientA2 = await migration.client.create({
      data: {
        organizationId: "org-a",
        name: "Cliente A2 Isolado",
        slug: `client-a2-iso-${Date.now()}`,
      },
    });

    await migration.rateLimit.deleteMany();
    const cookie = await login("editor-a");

    const brandName = `Marca Editor ${Date.now()}`;
    const createRes = await request(
      "/api/organizations/org-a/clients/client-a/brands",
      cookie,
      "POST",
      {
        name: brandName,
        description: "Desc",
        targetAudience: "Jovens",
        toneOfVoice: "Descontraído",
      },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string };

    const updateRes = await request(
      `/api/organizations/org-a/clients/client-a/brands/${created.id}`,
      cookie,
      "PATCH",
      {
        name: `${brandName} Atualizada`,
        description: "Desc atualizada",
        targetAudience: "Adultos",
        toneOfVoice: "Corporativo",
      },
    );
    expect(updateRes.status).toBe(200);

    const unassignedList = await request(
      `/api/organizations/org-a/clients/${clientA2.id}/brands`,
      cookie,
    );
    expect(unassignedList.status).toBe(404);

    const unassignedCreate = await request(
      `/api/organizations/org-a/clients/${clientA2.id}/brands`,
      cookie,
      "POST",
      { name: "Marca Invasora" },
    );
    expect(unassignedCreate.status).toBe(404);

    await migration.auditLog.deleteMany({ where: { entityId: created.id } });
    await migration.brand.delete({ where: { id: created.id } });
    await migration.client.delete({ where: { id: clientA2.id } });
  });

  it("R-1: prevents IDOR access when querying or updating a foreign brand (A2) via authorized client (A1) URL", async () => {
    // 1. Setup: Two clients A1 and A2 with their own brands
    const clientA2 = await migration.client.create({
      data: {
        organizationId: "org-a",
        name: "Cliente A2 IDOR",
        slug: `client-a2-idor-${Date.now()}`,
      },
    });

    const brandA1OriginalName = `Marca A1 Própria ${Date.now()}`;
    const brandA1 = await migration.brand.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        name: brandA1OriginalName,
        description: "Descrição A1",
        targetAudience: "Público A1",
        toneOfVoice: "Tom A1",
      },
    });

    const brandA2OriginalName = `Marca A2 Alheia Segredo ${Date.now()}`;
    const brandA2OriginalDesc = "Descrição confidencial do cliente A2";
    const brandA2 = await migration.brand.create({
      data: {
        organizationId: "org-a",
        clientId: clientA2.id,
        name: brandA2OriginalName,
        description: brandA2OriginalDesc,
        targetAudience: "Público A2 Exclusivo",
        toneOfVoice: "Tom A2 Exclusivo",
      },
    });

    try {
      // 2. User authorized ONLY in Client A1 (editor-a)
      await migration.rateLimit.deleteMany();
      const cookie = await login("editor-a");

      // 3. IDOR Query Attempt: URL with client-a (authorized) but brandA2.id (unauthorized)
      const idorGetRes = await request(
        `/api/organizations/org-a/clients/client-a/brands/${brandA2.id}`,
        cookie,
      );
      expect(idorGetRes.status).toBe(404);
      const idorGetData = (await idorGetRes.json()) as { message: string };
      expect(idorGetData.message).toBe("Marca não encontrada.");
      // Ensure no content from brand A2 is exposed
      const getRawText = JSON.stringify(idorGetData);
      expect(getRawText).not.toContain(brandA2OriginalName);
      expect(getRawText).not.toContain(brandA2OriginalDesc);
      expect(getRawText).not.toContain("Público A2 Exclusivo");

      // 4. IDOR Edit Attempt: URL with client-a (authorized) but brandA2.id (unauthorized)
      const idorPatchRes = await request(
        `/api/organizations/org-a/clients/client-a/brands/${brandA2.id}`,
        cookie,
        "PATCH",
        {
          name: "Tentativa de Invasão IDOR",
          description: "Texto Injetado",
          targetAudience: "Invasor",
          toneOfVoice: "Invasor",
        },
      );
      expect(idorPatchRes.status).toBe(404);
      const idorPatchData = (await idorPatchRes.json()) as { message: string };
      expect(idorPatchData.message).toBe("Marca não encontrada.");

      // 5. Verify that brand A2 was NOT altered in the database
      const brandA2InDb = await migration.brand.findUniqueOrThrow({
        where: { id: brandA2.id },
      });
      expect(brandA2InDb.name).toBe(brandA2OriginalName);
      expect(brandA2InDb.description).toBe(brandA2OriginalDesc);
      expect(brandA2InDb.targetAudience).toBe("Público A2 Exclusivo");
      expect(brandA2InDb.toneOfVoice).toBe("Tom A2 Exclusivo");

      // 6. Verify that no successful edit audit log was created for the denied attempt
      const foreignAuditLogs = await migration.auditLog.findMany({
        where: {
          entityId: brandA2.id,
          action: "brand.updated",
        },
      });
      expect(foreignAuditLogs).toEqual([]);

      // 7. Positive Case: User can query and edit their authorized brand A1
      const authorizedGetRes = await request(
        `/api/organizations/org-a/clients/client-a/brands/${brandA1.id}`,
        cookie,
      );
      expect(authorizedGetRes.status).toBe(200);
      const authorizedGetData = (await authorizedGetRes.json()) as {
        id: string;
        name: string;
      };
      expect(authorizedGetData.id).toBe(brandA1.id);
      expect(authorizedGetData.name).toBe(brandA1OriginalName);

      const updatedA1Name = `${brandA1OriginalName} Atualizada Legitimamente`;
      const authorizedPatchRes = await request(
        `/api/organizations/org-a/clients/client-a/brands/${brandA1.id}`,
        cookie,
        "PATCH",
        {
          name: updatedA1Name,
          description: "Descrição A1 atualizada",
          targetAudience: "Novo público A1",
          toneOfVoice: "Novo tom A1",
        },
      );
      expect(authorizedPatchRes.status).toBe(200);
      const authorizedPatchData = (await authorizedPatchRes.json()) as {
        name: string;
      };
      expect(authorizedPatchData.name).toBe(updatedA1Name);

      // Verify DB update and audit log for authorized brand A1
      const brandA1InDb = await migration.brand.findUniqueOrThrow({
        where: { id: brandA1.id },
      });
      expect(brandA1InDb.name).toBe(updatedA1Name);

      const brandA1Audit = await migration.auditLog.findFirst({
        where: {
          entityId: brandA1.id,
          action: "brand.updated",
          actorUserId: "editor-a",
        },
      });
      expect(brandA1Audit).not.toBeNull();
    } finally {
      await migration.auditLog.deleteMany({
        where: { entityId: { in: [brandA1.id, brandA2.id] } },
      });
      await migration.brand.deleteMany({
        where: { id: { in: [brandA1.id, brandA2.id] } },
      });
      await migration.client.delete({ where: { id: clientA2.id } });
    }
  });

  it("APPROVER and CLIENT_VIEWER can read brands, but cannot create or edit", async () => {
    const brand = await migration.brand.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        name: `Marca para Leitura ${Date.now()}`,
        description: "Apenas leitura",
        targetAudience: "Todos",
        toneOfVoice: "Neutro",
      },
    });

    try {
      for (const roleId of ["approver-a", "viewer-a"]) {
        await migration.rateLimit.deleteMany();
        const cookie = await login(roleId);

        const listRes = await request(
          "/api/organizations/org-a/clients/client-a/brands",
          cookie,
        );
        expect(listRes.status).toBe(200);
        const list = (await listRes.json()) as { id: string }[];
        expect(list.some((b) => b.id === brand.id)).toBe(true);

        const detailRes = await request(
          `/api/organizations/org-a/clients/client-a/brands/${brand.id}`,
          cookie,
        );
        expect(detailRes.status).toBe(200);

        const createRes = await request(
          "/api/organizations/org-a/clients/client-a/brands",
          cookie,
          "POST",
          { name: "Proibido" },
        );
        expect(createRes.status).toBe(403);
        const createErr = (await createRes.json()) as { message: string };
        expect(createErr.message).toContain("não pode criar marcas");

        const updateRes = await request(
          `/api/organizations/org-a/clients/client-a/brands/${brand.id}`,
          cookie,
          "PATCH",
          { name: "Proibido Alterar" },
        );
        expect(updateRes.status).toBe(403);
        const updateErr = (await updateRes.json()) as { message: string };
        expect(updateErr.message).toContain("não pode editar marcas");
      }
    } finally {
      await migration.brand.delete({ where: { id: brand.id } });
    }
  });

  it("input validation: rejects invalid names, oversized texts, and extra fields", async () => {
    await migration.rateLimit.deleteMany();
    const cookie = await login("admin-a");

    const shortName = await request(
      "/api/organizations/org-a/clients/client-a/brands",
      cookie,
      "POST",
      { name: "A" },
    );
    expect(shortName.status).toBe(400);

    const longName = await request(
      "/api/organizations/org-a/clients/client-a/brands",
      cookie,
      "POST",
      { name: "x".repeat(121) },
    );
    expect(longName.status).toBe(400);

    const longDesc = await request(
      "/api/organizations/org-a/clients/client-a/brands",
      cookie,
      "POST",
      { name: "Marca Válida", description: "d".repeat(2001) },
    );
    expect(longDesc.status).toBe(400);

    const extraField = await request(
      "/api/organizations/org-a/clients/client-a/brands",
      cookie,
      "POST",
      { name: "Marca Válida", organizationId: "org-b" },
    );
    expect(extraField.status).toBe(400);
  });

  it("revocation with open session: immediate cutoff of brand endpoints", async () => {
    await migration.rateLimit.deleteMany();
    const cookie = await login("editor-a");

    const beforeRes = await request(
      "/api/organizations/org-a/clients/client-a/brands",
      cookie,
    );
    expect(beforeRes.status).toBe(200);

    await migration.membership.update({
      where: { id: "membership-editor-a" },
      data: { active: false },
    });

    try {
      const afterGet = await request(
        "/api/organizations/org-a/clients/client-a/brands",
        cookie,
      );
      expect(afterGet.status).toBe(404);

      const afterPost = await request(
        "/api/organizations/org-a/clients/client-a/brands",
        cookie,
        "POST",
        { name: "Marca Pós-Revogação" },
      );
      expect(afterPost.status).toBe(404);
    } finally {
      await migration.membership.update({
        where: { id: "membership-editor-a" },
        data: { active: true },
      });
    }

    const restoredRes = await request(
      "/api/organizations/org-a/clients/client-a/brands",
      cookie,
    );
    expect(restoredRes.status).toBe(200);
  });

  describe("inactive entities blocking with open session (A-2)", () => {
    it("inactive client: blocks brand list, detail, creation, and edition with open session without data leakage or mutation", async () => {
      await migration.rateLimit.deleteMany();
      const cookie = await login("editor-a");

      const brandName = `Marca Ativa Antes ${randomUUID().slice(0, 8)}`;
      const brandDesc = "Descricao Secreta Cliente Inativo";
      const testBrand = await migration.brand.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          name: brandName,
          description: brandDesc,
          targetAudience: "Publico Secreto Cliente Inativo",
          toneOfVoice: "Tom Secreto Cliente Inativo",
        },
      });

      try {
        // 1. Positive baseline: confirm allowed access with open session before deactivation
        const baseList = await request(
          "/api/organizations/org-a/clients/client-a/brands",
          cookie,
        );
        expect(baseList.status).toBe(200);
        const baseListData = (await baseList.json()) as { id: string }[];
        expect(baseListData.some((b) => b.id === testBrand.id)).toBe(true);

        const baseDetail = await request(
          `/api/organizations/org-a/clients/client-a/brands/${testBrand.id}`,
          cookie,
        );
        expect(baseDetail.status).toBe(200);

        // 2. Inactivate client
        await migration.client.update({
          where: { id: "client-a" },
          data: { active: false },
        });

        // 3. Reusing the SAME open session:
        // 3a. Listagem (GET): 404, no brand data exposed
        const listRes = await request(
          "/api/organizations/org-a/clients/client-a/brands",
          cookie,
        );
        expect(listRes.status).toBe(404);
        const listBody = await listRes.text();
        expect(listBody).not.toContain(brandName);
        expect(listBody).not.toContain(brandDesc);

        // 3b. Detalhe (GET): 404, no brand data exposed
        const detailRes = await request(
          `/api/organizations/org-a/clients/client-a/brands/${testBrand.id}`,
          cookie,
        );
        expect(detailRes.status).toBe(404);
        const detailBody = await detailRes.text();
        expect(detailBody).not.toContain(brandName);
        expect(detailBody).not.toContain(brandDesc);
        expect(detailBody).not.toContain("Publico Secreto");

        // 3c. Criação (POST): 404, no creation in DB, no audit log
        const auditsBefore = await migration.auditLog.count({
          where: { organizationId: "org-a" },
        });
        const failCreateName = `Marca Indevida Cliente Inativo ${randomUUID().slice(0, 8)}`;
        const createRes = await request(
          "/api/organizations/org-a/clients/client-a/brands",
          cookie,
          "POST",
          { name: failCreateName },
        );
        expect(createRes.status).toBe(404);
        const createdInDb = await migration.brand.findFirst({
          where: { name: failCreateName },
        });
        expect(createdInDb).toBeNull();
        const auditsAfterCreate = await migration.auditLog.count({
          where: { organizationId: "org-a" },
        });
        expect(auditsAfterCreate).toBe(auditsBefore);

        // 3d. Edição (PATCH): 404, no DB mutation, no audit log
        const brandBefore = await migration.brand.findUniqueOrThrow({
          where: { id: testBrand.id },
        });
        const editRes = await request(
          `/api/organizations/org-a/clients/client-a/brands/${testBrand.id}`,
          cookie,
          "PATCH",
          {
            name: `Tentativa Alteracao ${randomUUID().slice(0, 8)}`,
            toneOfVoice: "Tom Alterado Indevidamente",
          },
        );
        expect(editRes.status).toBe(404);
        const brandAfter = await migration.brand.findUniqueOrThrow({
          where: { id: testBrand.id },
        });
        expect(brandAfter.name).toBe(brandBefore.name);
        expect(brandAfter.toneOfVoice).toBe(brandBefore.toneOfVoice);
        expect(brandAfter.updatedAt.getTime()).toBe(
          brandBefore.updatedAt.getTime(),
        );
        const auditsAfterEdit = await migration.auditLog.count({
          where: { organizationId: "org-a" },
        });
        expect(auditsAfterEdit).toBe(auditsBefore);
      } finally {
        await migration.client.update({
          where: { id: "client-a" },
          data: { active: true },
        });
        await migration.brand.deleteMany({ where: { id: testBrand.id } });
      }

      // 4. Positive restoration: verify access restored after reactivation with same session
      const restoredRes = await request(
        "/api/organizations/org-a/clients/client-a/brands",
        cookie,
      );
      expect(restoredRes.status).toBe(200);
    });

    it("inactive organization: blocks brand list, detail, creation, and edition with open session without data leakage or mutation", async () => {
      await migration.rateLimit.deleteMany();
      const cookie = await login("editor-a");

      const brandName = `Marca Org Ativa Antes ${randomUUID().slice(0, 8)}`;
      const brandDesc = "Descricao Secreta Org Inativa";
      const testBrand = await migration.brand.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          name: brandName,
          description: brandDesc,
          targetAudience: "Publico Secreto Org Inativa",
          toneOfVoice: "Tom Secreto Org Inativa",
        },
      });

      try {
        // 1. Positive baseline
        const baseList = await request(
          "/api/organizations/org-a/clients/client-a/brands",
          cookie,
        );
        expect(baseList.status).toBe(200);
        const baseDetail = await request(
          `/api/organizations/org-a/clients/client-a/brands/${testBrand.id}`,
          cookie,
        );
        expect(baseDetail.status).toBe(200);

        // 2. Inactivate organization
        await migration.organization.update({
          where: { id: "org-a" },
          data: { active: false },
        });

        // 3. Reusing the SAME open session:
        // 3a. Listagem: 404, no data leakage
        const listRes = await request(
          "/api/organizations/org-a/clients/client-a/brands",
          cookie,
        );
        expect(listRes.status).toBe(404);
        const listBody = await listRes.text();
        expect(listBody).not.toContain(brandName);
        expect(listBody).not.toContain(brandDesc);

        // 3b. Detalhe: 404, no data leakage
        const detailRes = await request(
          `/api/organizations/org-a/clients/client-a/brands/${testBrand.id}`,
          cookie,
        );
        expect(detailRes.status).toBe(404);
        const detailBody = await detailRes.text();
        expect(detailBody).not.toContain(brandName);
        expect(detailBody).not.toContain(brandDesc);

        // 3c. Criação: 404, no creation, no audit log
        const auditsBefore = await migration.auditLog.count({
          where: { organizationId: "org-a" },
        });
        const failCreateName = `Marca Indevida Org Inativa ${randomUUID().slice(0, 8)}`;
        const createRes = await request(
          "/api/organizations/org-a/clients/client-a/brands",
          cookie,
          "POST",
          { name: failCreateName },
        );
        expect(createRes.status).toBe(404);
        const createdInDb = await migration.brand.findFirst({
          where: { name: failCreateName },
        });
        expect(createdInDb).toBeNull();
        const auditsAfterCreate = await migration.auditLog.count({
          where: { organizationId: "org-a" },
        });
        expect(auditsAfterCreate).toBe(auditsBefore);

        // 3d. Edição: 404, no mutation, no audit log
        const brandBefore = await migration.brand.findUniqueOrThrow({
          where: { id: testBrand.id },
        });
        const editRes = await request(
          `/api/organizations/org-a/clients/client-a/brands/${testBrand.id}`,
          cookie,
          "PATCH",
          {
            name: `Tentativa Alteracao Org ${randomUUID().slice(0, 8)}`,
            toneOfVoice: "Tom Alterado Org",
          },
        );
        expect(editRes.status).toBe(404);
        const brandAfter = await migration.brand.findUniqueOrThrow({
          where: { id: testBrand.id },
        });
        expect(brandAfter.name).toBe(brandBefore.name);
        expect(brandAfter.toneOfVoice).toBe(brandBefore.toneOfVoice);
        expect(brandAfter.updatedAt.getTime()).toBe(
          brandBefore.updatedAt.getTime(),
        );
        const auditsAfterEdit = await migration.auditLog.count({
          where: { organizationId: "org-a" },
        });
        expect(auditsAfterEdit).toBe(auditsBefore);
      } finally {
        await migration.organization.update({
          where: { id: "org-a" },
          data: { active: true },
        });
        await migration.brand.deleteMany({ where: { id: testBrand.id } });
      }

      // 4. Positive restoration
      const restoredRes = await request(
        "/api/organizations/org-a/clients/client-a/brands",
        cookie,
      );
      expect(restoredRes.status).toBe(200);
    });

    it("inactive user: rejects open session with 401 across brand list, detail, creation, and edition without data leakage or mutation", async () => {
      await migration.rateLimit.deleteMany();
      const cookie = await login("editor-a");

      const brandName = `Marca User Ativo Antes ${randomUUID().slice(0, 8)}`;
      const brandDesc = "Descricao Secreta User Inativo";
      const testBrand = await migration.brand.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          name: brandName,
          description: brandDesc,
          targetAudience: "Publico Secreto User Inativo",
          toneOfVoice: "Tom Secreto User Inativo",
        },
      });

      try {
        // 1. Positive baseline
        const baseList = await request(
          "/api/organizations/org-a/clients/client-a/brands",
          cookie,
        );
        expect(baseList.status).toBe(200);
        const baseDetail = await request(
          `/api/organizations/org-a/clients/client-a/brands/${testBrand.id}`,
          cookie,
        );
        expect(baseDetail.status).toBe(200);

        // 2. Inactivate user
        await migration.user.update({
          where: { id: "editor-a" },
          data: { active: false },
        });

        // 3. Reusing the SAME open session:
        // 3a. Listagem: 401, no data leakage
        const listRes = await request(
          "/api/organizations/org-a/clients/client-a/brands",
          cookie,
        );
        expect(listRes.status).toBe(401);
        const listBody = await listRes.text();
        expect(listBody).not.toContain(brandName);
        expect(listBody).not.toContain(brandDesc);

        // 3b. Detalhe: 401, no data leakage
        const detailRes = await request(
          `/api/organizations/org-a/clients/client-a/brands/${testBrand.id}`,
          cookie,
        );
        expect(detailRes.status).toBe(401);
        const detailBody = await detailRes.text();
        expect(detailBody).not.toContain(brandName);
        expect(detailBody).not.toContain(brandDesc);

        // 3c. Criação: 401, no creation, no audit log
        const auditsBefore = await migration.auditLog.count({
          where: { organizationId: "org-a" },
        });
        const failCreateName = `Marca Indevida User Inativo ${randomUUID().slice(0, 8)}`;
        const createRes = await request(
          "/api/organizations/org-a/clients/client-a/brands",
          cookie,
          "POST",
          { name: failCreateName },
        );
        expect(createRes.status).toBe(401);
        const createdInDb = await migration.brand.findFirst({
          where: { name: failCreateName },
        });
        expect(createdInDb).toBeNull();
        const auditsAfterCreate = await migration.auditLog.count({
          where: { organizationId: "org-a" },
        });
        expect(auditsAfterCreate).toBe(auditsBefore);

        // 3d. Edição: 401, no mutation, no audit log
        const brandBefore = await migration.brand.findUniqueOrThrow({
          where: { id: testBrand.id },
        });
        const editRes = await request(
          `/api/organizations/org-a/clients/client-a/brands/${testBrand.id}`,
          cookie,
          "PATCH",
          {
            name: `Tentativa Alteracao User ${randomUUID().slice(0, 8)}`,
            toneOfVoice: "Tom Alterado User",
          },
        );
        expect(editRes.status).toBe(401);
        const brandAfter = await migration.brand.findUniqueOrThrow({
          where: { id: testBrand.id },
        });
        expect(brandAfter.name).toBe(brandBefore.name);
        expect(brandAfter.toneOfVoice).toBe(brandBefore.toneOfVoice);
        expect(brandAfter.updatedAt.getTime()).toBe(
          brandBefore.updatedAt.getTime(),
        );
        const auditsAfterEdit = await migration.auditLog.count({
          where: { organizationId: "org-a" },
        });
        expect(auditsAfterEdit).toBe(auditsBefore);
      } finally {
        await migration.user.update({
          where: { id: "editor-a" },
          data: { active: true },
        });
        await migration.brand.deleteMany({ where: { id: testBrand.id } });
      }

      // 4. Positive restoration
      const restoredRes = await request(
        "/api/organizations/org-a/clients/client-a/brands",
        cookie,
      );
      expect(restoredRes.status).toBe(200);
    });
  });
});
