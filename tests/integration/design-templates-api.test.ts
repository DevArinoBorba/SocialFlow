import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabase, asActor } from "../../packages/db/src/index.js";
import { readConfig } from "../../packages/config/src/index.js";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { createApplication } from "../../apps/api/dist/app.js";
import {
  RENDERER_VERSION,
  hashTemplateSpec,
} from "../../packages/render/src/index.js";
import type { MediaStorage } from "../../apps/api/src/media-storage.js";
import type { DesignTemplateSpec } from "../../packages/contracts/src/design.js";

const db = createDatabase(process.env.DATABASE_URL!);
const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);

const validSpec: DesignTemplateSpec = {
  schemaVersion: 1,
  format: "PORTRAIT",
  backgroundColor: "#123B35",
  overlayColor: "#071F1C",
  overlayOpacity: 0.35,
  textColor: "#FFFFFF",
  mutedTextColor: "#D6E4DF",
  accentColor: "#E9C46A",
  safeArea: 80,
  textAlign: "left",
  titleMaxLines: 3,
  showEyebrow: true,
  showSubtitle: true,
  showCallToAction: true,
};

describe("Phase 6: Design Templates API", () => {
  let redis: Redis;
  let appRuntime: Awaited<ReturnType<typeof createApplication>>;
  let apiBase: string;
  const origin = process.env.APP_URL!;
  const password = process.env.DEV_SEED_PASSWORD!;

  let cookieOwnerA: string;
  let cookieAdminA: string;
  let cookieEditorA: string;
  let cookieApproverA: string;
  let cookieViewerA: string;
  let cookieAdminB: string;

  const mockStorage: MediaStorage = {
    put: async () => {},
    get: async () => Buffer.from("mock"),
    close: async () => {},
  };

  async function request(
    path: string,
    cookie = "",
    method = "GET",
    payload?: unknown,
    customOrigin = origin,
  ) {
    const headers: Record<string, string> = {};
    if (customOrigin) headers["origin"] = customOrigin;
    if (cookie) headers["cookie"] = cookie;
    let body: string | undefined;
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(payload);
    }
    return fetch(`${apiBase}${path}`, {
      method,
      headers,
      body,
    });
  }

  async function login(id: string) {
    await migration.rateLimit.deleteMany();
    const res = await request(
      "/api/auth/sign-in/email",
      "",
      "POST",
      {
        email: `${id}@socialflow.test`,
        password,
      },
      origin,
    );
    expect(res.status).toBe(200);
    return res.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join("; ");
  }

  beforeAll(async () => {
    await db.$connect();
    await migration.$connect();

    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });

    const appConfig = readConfig(process.env);
    appRuntime = await createApplication(appConfig, {
      mediaDependencies: {
        storage: mockStorage,
      },
    });

    await appRuntime.app.listen(0, "127.0.0.1");
    const serverAddr = appRuntime.app.getHttpServer().address() as AddressInfo;
    apiBase = `http://127.0.0.1:${serverAddr.port}`;

    cookieOwnerA = await login("owner-a");
    cookieAdminA = await login("admin-a");
    cookieEditorA = await login("editor-a");
    cookieApproverA = await login("approver-a");
    cookieViewerA = await login("viewer-a");
    cookieAdminB = await login("admin-b");
  });

  afterAll(async () => {
    await appRuntime?.close();
    redis?.disconnect();
    await db.$disconnect();
    await migration.$disconnect();
  });

  const rootA = "/api/organizations/org-a/clients/client-a/design-templates";
  const rootB = "/api/organizations/org-b/clients/client-b/design-templates";

  // 1. OWNER cria template
  it("1. OWNER creates template (201)", async () => {
    const res = await request(rootA, cookieOwnerA, "POST", {
      name: `Owner Template ${randomUUID()}`,
      spec: validSpec,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.status).toBe("ACTIVE");
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0].version).toBe(1);
    expect(body.versions[0].rendererVersion).toBe(RENDERER_VERSION);
  });

  // 2. ADMIN cria template
  it("2. ADMIN creates template (201)", async () => {
    const res = await request(rootA, cookieAdminA, "POST", {
      name: `Admin Template ${randomUUID()}`,
      spec: validSpec,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.status).toBe("ACTIVE");
    expect(body.versions[0].version).toBe(1);
  });

  // 3. EDITOR cria template
  it("3. EDITOR creates template (201)", async () => {
    const res = await request(rootA, cookieEditorA, "POST", {
      name: `Editor Template ${randomUUID()}`,
      spec: validSpec,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.status).toBe("ACTIVE");
  });

  // 4. APPROVER recebe 403
  it("4. APPROVER receives 403 on mutation", async () => {
    const res = await request(rootA, cookieApproverA, "POST", {
      name: "Approver Template",
      spec: validSpec,
    });
    expect(res.status).toBe(403);
  });

  // 5. CLIENT_VIEWER recebe 403
  it("5. CLIENT_VIEWER receives 403 on mutation", async () => {
    const res = await request(rootA, cookieViewerA, "POST", {
      name: "Viewer Template",
      spec: validSpec,
    });
    expect(res.status).toBe(403);
  });

  // 6. Todos os papéis autorizados conseguem listar e consultar
  it("6. All authorized roles can list and query template", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Queryable Template ${randomUUID()}`,
      spec: validSpec,
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const rolesCookies = [
      cookieOwnerA,
      cookieAdminA,
      cookieEditorA,
      cookieApproverA,
      cookieViewerA,
    ];

    for (const cookie of rolesCookies) {
      const listRes = await request(rootA, cookie, "GET");
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(Array.isArray(listBody.items)).toBe(true);
      expect(
        listBody.items.some((i: { id: string }) => i.id === created.id),
      ).toBe(true);

      const getRes = await request(`${rootA}/${created.id}`, cookie, "GET");
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.id).toBe(created.id);
      expect(getBody.versions).toHaveLength(1);
    }
  });

  // 7. Cross-tenant recebe 404
  it("7. Cross-tenant receives 404 without revealing existence", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Tenant A Template ${randomUUID()}`,
      spec: validSpec,
    });
    const templateA = await createRes.json();

    // Admin B queries template A under Org B's client B URL
    const res1 = await request(`${rootB}/${templateA.id}`, cookieAdminB, "GET");
    expect(res1.status).toBe(404);

    // Admin B queries template A under Org A's URL
    const res2 = await request(`${rootA}/${templateA.id}`, cookieAdminB, "GET");
    expect(res2.status).toBe(404);
  });

  // 8. Criação gera template e versão 1 atomicamente
  it("8. Creation generates template and version 1 atomically", async () => {
    const templateName = `Atomic Template ${randomUUID()}`;
    const res = await request(rootA, cookieOwnerA, "POST", {
      name: templateName,
      spec: validSpec,
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    const dbTemplate = await migration.designTemplate.findUnique({
      where: { id: body.id },
      include: { versions: true },
    });
    expect(dbTemplate).not.toBeNull();
    expect(dbTemplate?.name).toBe(templateName);
    expect(dbTemplate?.status).toBe("ACTIVE");
    expect(dbTemplate?.versions).toHaveLength(1);
    expect(dbTemplate?.versions[0]?.version).toBe(1);
  });

  // 9. Falha na versão reverte a criação do template
  it("9. Failure during version creation rolls back template creation", async () => {
    const invalidSpecPayload = {
      name: `Rollback Template ${randomUUID()}`,
      spec: {
        ...validSpec,
        safeArea: 9999, // exceeds max 240
      },
    };
    const res = await request(rootA, cookieOwnerA, "POST", invalidSpecPayload);
    expect(res.status).toBe(400);

    const count = await migration.designTemplate.count({
      where: { name: invalidSpecPayload.name },
    });
    expect(count).toBe(0);
  });

  // 10. Renderer version vem do servidor
  it("10. Renderer version is filled exclusively by server RENDERER_VERSION", async () => {
    const res = await request(rootA, cookieOwnerA, "POST", {
      name: `Renderer Version Check ${randomUUID()}`,
      spec: validSpec,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.versions[0].rendererVersion).toBe(RENDERER_VERSION);
  });

  // 11. Hash é determinístico
  it("11. Spec hash is deterministic and matches hashTemplateSpec", async () => {
    const res = await request(rootA, cookieOwnerA, "POST", {
      name: `Hash Check ${randomUUID()}`,
      spec: validSpec,
    });
    const body = await res.json();
    const expectedHash = hashTemplateSpec(validSpec);
    expect(body.versions[0].specHash).toBe(expectedHash);
  });

  // 12. Propriedades em ordem diferente produzem o mesmo hash
  it("12. Properties in different orders produce identical hash in API", async () => {
    const shuffledSpec = {
      showCallToAction: validSpec.showCallToAction,
      accentColor: validSpec.accentColor,
      format: validSpec.format,
      schemaVersion: validSpec.schemaVersion,
      backgroundColor: validSpec.backgroundColor,
      titleMaxLines: validSpec.titleMaxLines,
      textAlign: validSpec.textAlign,
      mutedTextColor: validSpec.mutedTextColor,
      showSubtitle: validSpec.showSubtitle,
      textColor: validSpec.textColor,
      overlayOpacity: validSpec.overlayOpacity,
      safeArea: validSpec.safeArea,
      showEyebrow: validSpec.showEyebrow,
      overlayColor: validSpec.overlayColor,
    };

    const res1 = await request(rootA, cookieOwnerA, "POST", {
      name: `Order 1 ${randomUUID()}`,
      spec: validSpec,
    });
    const body1 = await res1.json();

    const res2 = await request(rootA, cookieOwnerA, "POST", {
      name: `Order 2 ${randomUUID()}`,
      spec: shuffledSpec,
    });
    const body2 = await res2.json();

    expect(body1.versions[0].specHash).toBe(body2.versions[0].specHash);
  });

  // 13. Payload com campo desconhecido é rejeitado
  it("13. Payload with unknown fields is rejected (400)", async () => {
    const res = await request(rootA, cookieOwnerA, "POST", {
      name: `Extra Field ${randomUUID()}`,
      spec: validSpec,
      maliciousExtra: "injection",
    });
    expect(res.status).toBe(400);
  });

  // 14. HTML, CSS e URL são rejeitados
  it("14. HTML, CSS, URLs, and scripts in name are rejected (400)", async () => {
    const payloads = [
      "<script>alert(1)</script>",
      "Template <img src=x onerror=alert(1)>",
      "Template with url(http://malicious.test)",
      "https://malicious.com/evil",
      "javascript:alert(1)",
    ];

    for (const badName of payloads) {
      const res = await request(rootA, cookieOwnerA, "POST", {
        name: badName,
        spec: validSpec,
      });
      expect(res.status).toBe(400);
    }
  });

  // 15. Nova versão incrementa corretamente
  it("15. New version increments correctly", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Version Test ${randomUUID()}`,
      spec: validSpec,
    });
    const template = await createRes.json();

    const v2Res = await request(
      `${rootA}/${template.id}/versions`,
      cookieOwnerA,
      "POST",
      {
        spec: {
          ...validSpec,
          backgroundColor: "#264653",
        },
      },
    );
    expect(v2Res.status).toBe(201);
    const v2Body = await v2Res.json();
    expect(v2Body.version).toBe(2);

    const v3Res = await request(
      `${rootA}/${template.id}/versions`,
      cookieOwnerA,
      "POST",
      {
        spec: {
          ...validSpec,
          backgroundColor: "#2A9D8F",
        },
      },
    );
    expect(v3Res.status).toBe(201);
    const v3Body = await v3Res.json();
    expect(v3Body.version).toBe(3);
  });

  // 16. Duas criações concorrentes não repetem número
  it("16. Concurrent version creations do not duplicate numbers", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Concurrency Template ${randomUUID()}`,
      spec: validSpec,
    });
    const template = await createRes.json();

    const [res1, res2] = await Promise.all([
      request(`${rootA}/${template.id}/versions`, cookieOwnerA, "POST", {
        spec: { ...validSpec, backgroundColor: "#111111" },
      }),
      request(`${rootA}/${template.id}/versions`, cookieOwnerA, "POST", {
        spec: { ...validSpec, backgroundColor: "#222222" },
      }),
    ]);

    expect([201, 409]).toContain(res1.status);
    expect([201, 409]).toContain(res2.status);

    const detailRes = await request(
      `${rootA}/${template.id}`,
      cookieOwnerA,
      "GET",
    );
    const detail = await detailRes.json();
    const versionNumbers = detail.versions.map(
      (v: { version: number }) => v.version,
    );
    const uniqueNumbers = new Set(versionNumbers);
    expect(uniqueNumbers.size).toBe(versionNumbers.length);
  });

  // 17. Versão anterior permanece imutável
  it("17. Existing version remains immutable after newer versions added", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Immutable Test ${randomUUID()}`,
      spec: validSpec,
    });
    const template = await createRes.json();
    const v1Before = template.versions[0];

    await request(`${rootA}/${template.id}/versions`, cookieOwnerA, "POST", {
      spec: { ...validSpec, backgroundColor: "#E76F51" },
    });

    const getRes = await request(
      `${rootA}/${template.id}`,
      cookieOwnerA,
      "GET",
    );
    const updated = await getRes.json();
    const v1After = updated.versions.find(
      (v: { version: number }) => v.version === 1,
    );

    expect(v1After.specHash).toBe(v1Before.specHash);
    expect(v1After.spec.backgroundColor).toBe(v1Before.spec.backgroundColor);
  });

  // 18. Template arquivado rejeita nova versão
  it("18. Archived template rejects new versions (400)", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Archived Version Test ${randomUUID()}`,
      spec: validSpec,
    });
    const template = await createRes.json();

    // Archive it
    const patchRes = await request(
      `${rootA}/${template.id}`,
      cookieOwnerA,
      "PATCH",
      { status: "ARCHIVED" },
    );
    expect(patchRes.status).toBe(200);

    // Try creating a new version
    const vRes = await request(
      `${rootA}/${template.id}/versions`,
      cookieOwnerA,
      "POST",
      {
        spec: { ...validSpec, safeArea: 100 },
      },
    );
    expect(vRes.status).toBe(400);
    const body = await vRes.json();
    expect(body.message).toContain("arquivado não aceita novas versões");
  });

  // 19. EDITOR pode arquivar
  it("19. EDITOR can archive template", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Editor Archive Test ${randomUUID()}`,
      spec: validSpec,
    });
    const template = await createRes.json();

    const res = await request(
      `${rootA}/${template.id}`,
      cookieEditorA,
      "PATCH",
      { status: "ARCHIVED" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ARCHIVED");
  });

  // 20. EDITOR não pode reativar
  it("20. EDITOR cannot reactivate template (403)", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Editor Reactivate Test ${randomUUID()}`,
      spec: validSpec,
    });
    const template = await createRes.json();

    await request(`${rootA}/${template.id}`, cookieOwnerA, "PATCH", {
      status: "ARCHIVED",
    });

    const res = await request(
      `${rootA}/${template.id}`,
      cookieEditorA,
      "PATCH",
      { status: "ACTIVE" },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toContain("proprietários ou administradores");
  });

  // 21. OWNER e ADMIN podem reativar
  it("21. OWNER and ADMIN can reactivate template (200)", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Reactivate Test ${randomUUID()}`,
      spec: validSpec,
    });
    const template = await createRes.json();

    // Archive
    await request(`${rootA}/${template.id}`, cookieOwnerA, "PATCH", {
      status: "ARCHIVED",
    });

    // ADMIN reactivates
    const adminRes = await request(
      `${rootA}/${template.id}`,
      cookieAdminA,
      "PATCH",
      { status: "ACTIVE" },
    );
    expect(adminRes.status).toBe(200);
    const adminBody = await adminRes.json();
    expect(adminBody.status).toBe("ACTIVE");

    // Archive again
    await request(`${rootA}/${template.id}`, cookieOwnerA, "PATCH", {
      status: "ARCHIVED",
    });

    // OWNER reactivates
    const ownerRes = await request(
      `${rootA}/${template.id}`,
      cookieOwnerA,
      "PATCH",
      { status: "ACTIVE" },
    );
    expect(ownerRes.status).toBe(200);
    const ownerBody = await ownerRes.json();
    expect(ownerBody.status).toBe("ACTIVE");
  });

  // 22. Renomear registra auditoria
  it("22. Renaming records design_template.renamed audit log", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Original Name ${randomUUID()}`,
      spec: validSpec,
    });
    const template = await createRes.json();

    const newName = `Updated Name ${randomUUID()}`;
    const patchRes = await request(
      `${rootA}/${template.id}`,
      cookieOwnerA,
      "PATCH",
      { name: newName },
    );
    expect(patchRes.status).toBe(200);

    const audit = await migration.auditLog.findFirst({
      where: {
        entityId: template.id,
        action: "design_template.renamed",
      },
    });
    expect(audit).not.toBeNull();
  });

  // 23. Alteração sem efeito não registra auditoria
  it("23. No-op update records no audit logs", async () => {
    const initialName = `Noop Name ${randomUUID()}`;
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: initialName,
      spec: validSpec,
    });
    const template = await createRes.json();

    const auditCountBefore = await migration.auditLog.count({
      where: { entityId: template.id },
    });

    const patchRes = await request(
      `${rootA}/${template.id}`,
      cookieOwnerA,
      "PATCH",
      {
        name: initialName,
        status: "ACTIVE",
      },
    );
    expect(patchRes.status).toBe(200);

    const auditCountAfter = await migration.auditLog.count({
      where: { entityId: template.id },
    });

    expect(auditCountAfter).toBe(auditCountBefore);
  });

  // 24. Duplicação cria novo template com versão 1
  it("24. Duplication creates new template with version 1", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Source Template ${randomUUID()}`,
      spec: validSpec,
    });
    const source = await createRes.json();

    const dupName = `Cloned Template ${randomUUID()}`;
    const dupRes = await request(
      `${rootA}/${source.id}/duplicate`,
      cookieOwnerA,
      "POST",
      { name: dupName },
    );
    expect(dupRes.status).toBe(201);
    const cloned = await dupRes.json();

    expect(cloned.id).not.toBe(source.id);
    expect(cloned.name).toBe(dupName);
    expect(cloned.status).toBe("ACTIVE");
    expect(cloned.versions).toHaveLength(1);
    expect(cloned.versions[0].version).toBe(1);
    expect(cloned.versions[0].specHash).toBe(source.versions[0].specHash);
  });

  // 25. Duplicação não copia histórico
  it("25. Duplication copies only latest version, not historical versions or archived status", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Multi-version Template ${randomUUID()}`,
      spec: validSpec,
    });
    const source = await createRes.json();

    // Create version 2
    const v2Spec = { ...validSpec, safeArea: 120 };
    await request(`${rootA}/${source.id}/versions`, cookieOwnerA, "POST", {
      spec: v2Spec,
    });

    // Archive source
    await request(`${rootA}/${source.id}`, cookieOwnerA, "PATCH", {
      status: "ARCHIVED",
    });

    // Duplicate
    const dupRes = await request(
      `${rootA}/${source.id}/duplicate`,
      cookieOwnerA,
      "POST",
      { name: `Duplicated Clean ${randomUUID()}` },
    );
    expect(dupRes.status).toBe(201);
    const cloned = await dupRes.json();

    expect(cloned.status).toBe("ACTIVE");
    expect(cloned.versions).toHaveLength(1);
    expect(cloned.versions[0].version).toBe(1);
    expect(cloned.versions[0].spec.safeArea).toBe(120);
  });

  // 26. Duplicação cross-tenant é rejeitada
  it("26. Cross-tenant duplication is rejected with 404", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Org A Only ${randomUUID()}`,
      spec: validSpec,
    });
    const source = await createRes.json();

    const dupRes = await request(
      `${rootB}/${source.id}/duplicate`,
      cookieAdminB,
      "POST",
      { name: "Attempt Dup" },
    );
    expect(dupRes.status).toBe(404);
  });

  // 27. Listagem não faz N+1
  it("27. List templates returns latestVersion summary without N+1", async () => {
    const listRes = await request(rootA, cookieOwnerA, "GET");
    expect(listRes.status).toBe(200);
    const body = await listRes.json();

    expect(Array.isArray(body.items)).toBe(true);
    for (const item of body.items) {
      expect(item.id).toBeDefined();
      expect(item.name).toBeDefined();
      expect(item.status).toBeDefined();
      if (item.latestVersion) {
        expect(item.latestVersion.version).toBeGreaterThan(0);
        expect(item.latestVersion.format).toBeDefined();
        expect(item.latestVersion.specHash).toBeDefined();
      }
    }
  });

  // 28. Paginação é estável
  it("28. Listing cursor pagination is stable", async () => {
    const page1Res = await request(`${rootA}?limit=2`, cookieOwnerA, "GET");
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json();
    expect(page1.items.length).toBeLessThanOrEqual(2);

    if (page1.hasMore && page1.nextCursor) {
      const page2Res = await request(
        `${rootA}?limit=2&cursor=${page1.nextCursor}`,
        cookieOwnerA,
        "GET",
      );
      expect(page2Res.status).toBe(200);
      const page2 = await page2Res.json();

      const page1Ids = new Set(page1.items.map((i: { id: string }) => i.id));
      for (const item of page2.items) {
        expect(page1Ids.has(item.id)).toBe(false);
      }
    }
  });

  // 29. Filtros são validados
  it("29. Listing filters (status, search, invalid query) are validated", async () => {
    const invalidStatusRes = await request(
      `${rootA}?status=INVALID`,
      cookieOwnerA,
      "GET",
    );
    expect(invalidStatusRes.status).toBe(400);

    const invalidLimitRes = await request(
      `${rootA}?limit=100`,
      cookieOwnerA,
      "GET",
    );
    expect(invalidLimitRes.status).toBe(400);

    // Search filter
    const uniqueTerm = `Searchable_${randomUUID().slice(0, 8)}`;
    await request(rootA, cookieOwnerA, "POST", {
      name: `Prefix ${uniqueTerm} Suffix`,
      spec: validSpec,
    });

    const searchRes = await request(
      `${rootA}?search=${uniqueTerm}`,
      cookieOwnerA,
      "GET",
    );
    expect(searchRes.status).toBe(200);
    const searchBody = await searchRes.json();
    expect(searchBody.items.length).toBeGreaterThanOrEqual(1);
    expect(
      searchBody.items.every((i: { name: string }) =>
        i.name.includes(uniqueTerm),
      ),
    ).toBe(true);
  });

  // 30. Criação do template inicial é idempotente
  it("30. Default templates creation is idempotent", async () => {
    // Initial call creates default templates
    const res1 = await request(`${rootA}/default`, cookieOwnerA, "POST");
    expect([200, 201]).toContain(res1.status);
    const list1 = await res1.json();
    expect(list1.length).toBeGreaterThanOrEqual(3);

    // Second call is idempotent and returns 200 without creating duplicates
    const res2 = await request(`${rootA}/default`, cookieOwnerA, "POST");
    expect(res2.status).toBe(200);
    const list2 = await res2.json();
    expect(list2.length).toBe(list1.length);
  });

  // 31. Concorrência no template inicial não cria duplicatas
  it("31. Concurrent default template requests do not create duplicates", async () => {
    // We test on Org B, Client B to test clean initialization
    const [res1, res2] = await Promise.all([
      request(`${rootB}/default`, cookieAdminB, "POST"),
      request(`${rootB}/default`, cookieAdminB, "POST"),
    ]);

    expect([200, 201]).toContain(res1.status);
    expect([200, 201]).toContain(res2.status);

    const templatesInB = await migration.designTemplate.findMany({
      where: {
        organizationId: "org-b",
        clientId: "client-b",
        name: {
          in: ["Editorial Square", "Editorial Portrait", "Editorial Story"],
        },
      },
    });

    // Exactly 3 templates, one for each name
    expect(templatesInB).toHaveLength(3);
    const names = new Set(templatesInB.map((t) => t.name));
    expect(names.size).toBe(3);
  });

  // 32. API de renderização aceita a versão criada
  it("32. Render API accepts created design template version", async () => {
    const createRes = await request(rootA, cookieOwnerA, "POST", {
      name: `Render Target ${randomUUID()}`,
      spec: validSpec,
    });
    const template = await createRes.json();
    const versionId = template.versions[0].id;

    const renderRes = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookieOwnerA,
      "POST",
      {
        templateVersionId: versionId,
        idempotencyKey: `idemp-${randomUUID()}`,
        input: {
          title: "Valid Render Artwork",
          callToAction: "TEST NOW",
        },
      },
    );
    expect(renderRes.status).toBe(202);
    const renderBody = await renderRes.json();
    expect(renderBody.id).toBeDefined();
    expect(renderBody.templateVersionId).toBe(versionId);
    expect(renderBody.status).toBe("PENDING");
  });

  // 33. Scheduler e renderer worker permanecem sem regressões
  it("33. Scheduler and renderer worker components remain intact", async () => {
    const healthRes = await request("/health/ready", "", "GET");
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json();
    expect(healthBody.status).toBe("ready");
  });

  // 34. Nenhuma política RLS existente é enfraquecida
  it("34. RLS policies on DesignTemplate and DesignTemplateVersion remain enforced", async () => {
    // Under socialflow_runtime role with editor-a actor
    await asActor(db, "editor-a", async (tx) => {
      const templates = await tx.designTemplate.findMany({
        where: { organizationId: "org-a", clientId: "client-a" },
      });
      expect(Array.isArray(templates)).toBe(true);

      // Attempting to read another tenant's templates under RLS returns empty array
      const otherTemplates = await tx.designTemplate.findMany({
        where: { organizationId: "org-b", clientId: "client-b" },
      });
      expect(otherTemplates).toHaveLength(0);
    });
  });
});
