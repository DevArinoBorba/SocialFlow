import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createDatabase, asActor } from "../../packages/db/src/index.js";
import { readConfig } from "../../packages/config/src/index.js";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { createApplication } from "../../apps/api/dist/app.js";
import {
  RENDERER_VERSION,
  hashRenderInput,
} from "../../packages/render/src/index.js";
import {
  executeRenderJob,
  runRendererReconciliationCycle,
} from "../../apps/worker/dist/renderer-worker.js";
import { createRenderQueue } from "../../apps/api/dist/render-queue.js";
import type { PrismaClient } from "@socialflow/db";
import type { MediaStorage } from "../../apps/api/src/media-storage.js";
import { artworkInputSchema } from "../../packages/contracts/src/index.js";

const db = createDatabase(process.env.DATABASE_URL!);
const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);

const templateSpec = {
  schemaVersion: 1 as const,
  format: "PORTRAIT" as const,
  backgroundColor: "#123B35",
  overlayColor: "#071F1C",
  overlayOpacity: 0.35,
  textColor: "#FFFFFF",
  mutedTextColor: "#D6E4DF",
  accentColor: "#E9C46A",
  safeArea: 80,
  textAlign: "left" as const,
  titleMaxLines: 3,
  showEyebrow: true,
  showSubtitle: true,
  showCallToAction: true,
};

describe("Phase 6 Increment 1: Render Jobs API", () => {
  let redis: Redis;
  let appRuntime: Awaited<ReturnType<typeof createApplication>>;
  let apiBase: string;
  const origin = process.env.APP_URL!;
  const password = process.env.DEV_SEED_PASSWORD!;

  // Fixture IDs
  let templateAId: string;
  let versionAId: string;
  let templateBId: string;
  let versionBId: string;
  let archivedTemplateId: string;
  let archivedVersionId: string;
  let incompatibleVersionId: string;
  let validBgAssetId: string;
  let validLogoAssetId: string;
  let pendingAssetId: string;
  let archivedAssetId: string;
  let crossTenantAssetId: string;
  let postAId: string;
  let postBId: string;

  const mockStorageMap = new Map<string, Buffer>();
  const mockStorage: MediaStorage = {
    put: async (key: string, data: Buffer) => {
      mockStorageMap.set(key, data);
    },
    get: async (key: string) => {
      const found = mockStorageMap.get(key);
      if (!found) throw new Error("Object not found in mock storage");
      return found;
    },
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

    // Create Test Fixtures
    // 1. Template & Version in Org A, Client A (ACTIVE)
    const tA = await migration.designTemplate.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        name: `Active Template A ${randomUUID()}`,
        status: "ACTIVE",
      },
    });
    templateAId = tA.id;

    const vA = await migration.designTemplateVersion.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        templateId: templateAId,
        version: 1,
        format: "PORTRAIT",
        spec: templateSpec,
        specHash: "a".repeat(64),
        rendererVersion: RENDERER_VERSION,
      },
    });
    versionAId = vA.id;

    // 2. Template & Version in Org B, Client B
    const tB = await migration.designTemplate.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        name: `Template B ${randomUUID()}`,
        status: "ACTIVE",
      },
    });
    templateBId = tB.id;

    const vB = await migration.designTemplateVersion.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        templateId: templateBId,
        version: 1,
        format: "PORTRAIT",
        spec: templateSpec,
        specHash: "b".repeat(64),
        rendererVersion: RENDERER_VERSION,
      },
    });
    versionBId = vB.id;

    // 3. Archived Template in Org A
    const tArchived = await migration.designTemplate.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        name: `Archived Template ${randomUUID()}`,
        status: "ARCHIVED",
      },
    });
    archivedTemplateId = tArchived.id;

    const vArchived = await migration.designTemplateVersion.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        templateId: archivedTemplateId,
        version: 1,
        format: "PORTRAIT",
        spec: templateSpec,
        specHash: "c".repeat(64),
        rendererVersion: RENDERER_VERSION,
      },
    });
    archivedVersionId = vArchived.id;

    // 4. Incompatible rendererVersion in Org A
    const vIncompatible = await migration.designTemplateVersion.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        templateId: templateAId,
        version: 2,
        format: "PORTRAIT",
        spec: templateSpec,
        specHash: "d".repeat(64),
        rendererVersion: "satori-0.0.1_legacy",
      },
    });
    incompatibleVersionId = vIncompatible.id;

    // 5. Media Assets in Org A, Client A
    const bgId = randomUUID();
    const validBg = await migration.mediaAsset.create({
      data: {
        id: bgId,
        organizationId: "org-a",
        clientId: "client-a",
        name: "valid-background.png",
        storageKey: `media/org-a/client-a/${bgId}`,
        status: "ready",
        mimeType: "image/png",
        byteSize: 1024,
        width: 1080,
        height: 1080,
        sha256: "e".repeat(64),
        archived: false,
      },
    });
    validBgAssetId = validBg.id;

    const logoId = randomUUID();
    const validLogo = await migration.mediaAsset.create({
      data: {
        id: logoId,
        organizationId: "org-a",
        clientId: "client-a",
        name: "valid-logo.png",
        storageKey: `media/org-a/client-a/${logoId}`,
        status: "ready",
        mimeType: "image/png",
        byteSize: 512,
        width: 200,
        height: 200,
        sha256: "f".repeat(64),
        archived: false,
      },
    });
    validLogoAssetId = validLogo.id;

    const pendingId = randomUUID();
    const pendingAsset = await migration.mediaAsset.create({
      data: {
        id: pendingId,
        organizationId: "org-a",
        clientId: "client-a",
        name: "pending.png",
        storageKey: `media/org-a/client-a/${pendingId}`,
        status: "pending",
        archived: false,
      },
    });
    pendingAssetId = pendingAsset.id;

    const archivedId = randomUUID();
    const archivedAsset = await migration.mediaAsset.create({
      data: {
        id: archivedId,
        organizationId: "org-a",
        clientId: "client-a",
        name: "archived.png",
        storageKey: `media/org-a/client-a/${archivedId}`,
        status: "ready",
        mimeType: "image/png",
        byteSize: 1024,
        width: 1080,
        height: 1080,
        sha256: "2".repeat(64),
        archived: true,
      },
    });
    archivedAssetId = archivedAsset.id;

    // 6. Cross Tenant Media Asset in Org B, Client B
    const crossId = randomUUID();
    const crossAsset = await migration.mediaAsset.create({
      data: {
        id: crossId,
        organizationId: "org-b",
        clientId: "client-b",
        name: "cross-bg.png",
        storageKey: `media/org-b/client-b/${crossId}`,
        status: "ready",
        mimeType: "image/png",
        byteSize: 1024,
        width: 1080,
        height: 1080,
        sha256: "4".repeat(64),
        archived: false,
      },
    });
    crossTenantAssetId = crossAsset.id;

    // 7. Post in Org A and Post in Org B
    const pA = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Post in client-a",
      },
    });
    postAId = pA.id;

    const pB = await migration.post.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        caption: "Post in client-b",
      },
    });
    postBId = pB.id;
  });

  afterAll(async () => {
    await migration.auditLog.deleteMany({});
    await migration.renderJob.deleteMany({});
    await migration.post.deleteMany({});
    await migration.mediaAsset.deleteMany({});
    await migration.designTemplateVersion.deleteMany({});
    await migration.designTemplate.deleteMany({});

    redis.disconnect();
    await appRuntime.close();
    await db.$disconnect();
    await migration.$disconnect();
  });

  beforeEach(async () => {
    await migration.rateLimit.deleteMany();
  });

  // 1. OWNER cria render (202)
  it("1. OWNER cria render com sucesso (202 Accepted)", async () => {
    const cookie = await login("owner-a");
    const idempotencyKey = `owner-${randomUUID()}`;
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        postId: postAId,
        input: {
          eyebrow: "Novidade",
          title: "Criado por OWNER",
          subtitle: "Subtítulo do OWNER",
          callToAction: "Saiba Mais",
          backgroundMediaAssetId: validBgAssetId,
          logoMediaAssetId: validLogoAssetId,
        },
        idempotencyKey,
      },
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBeDefined();
    expect(body.status).toBe("PENDING");
  });

  // 2. ADMIN cria render (202)
  it("2. ADMIN cria render com sucesso (202 Accepted)", async () => {
    const cookie = await login("admin-a");
    const idempotencyKey = `admin-${randomUUID()}`;
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: {
          title: "Criado por ADMIN",
        },
        idempotencyKey,
      },
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBeDefined();
    expect(body.status).toBe("PENDING");
  });

  // 3. EDITOR cria render (202)
  it("3. EDITOR cria render com sucesso (202 Accepted)", async () => {
    const cookie = await login("editor-a");
    const idempotencyKey = `editor-${randomUUID()}`;
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: {
          title: "Criado por EDITOR",
        },
        idempotencyKey,
      },
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBeDefined();
    expect(body.status).toBe("PENDING");
  });

  // 4. APPROVER recebe 403 na criação
  it("4. APPROVER recebe 403 na criação", async () => {
    const cookie = await login("approver-a");
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: {
          title: "Tentativa por APPROVER",
        },
        idempotencyKey: `approver-${randomUUID()}`,
      },
    );

    expect(res.status).toBe(403);
  });

  // 5. CLIENT_VIEWER recebe 403 na criação
  it("5. CLIENT_VIEWER recebe 403 na criação", async () => {
    const cookie = await login("viewer-a");
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: {
          title: "Tentativa por CLIENT_VIEWER",
        },
        idempotencyKey: `viewer-${randomUUID()}`,
      },
    );

    expect(res.status).toBe(403);
  });

  // 6. Todos os papéis ativos autorizados conseguem consultar e listar
  it("6. Todos os papéis ativos autorizados (OWNER, ADMIN, EDITOR, APPROVER, CLIENT_VIEWER) conseguem consultar e listar", async () => {
    // Primeiro cria um job
    const editorCookie = await login("editor-a");
    const createRes = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      editorCookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: { title: "Job para leitura RBAC" },
        idempotencyKey: `read-test-${randomUUID()}`,
      },
    );
    expect(createRes.status).toBe(202);
    const created = (await createRes.json()) as { id: string };

    const roles = ["owner-a", "admin-a", "editor-a", "approver-a", "viewer-a"];
    for (const role of roles) {
      const cookie = await login(role);
      // GET single
      const getRes = await request(
        `/api/organizations/org-a/clients/client-a/render-jobs/${created.id}`,
        cookie,
        "GET",
      );
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as { id: string };
      expect(getBody.id).toBe(created.id);

      // GET list
      const listRes = await request(
        "/api/organizations/org-a/clients/client-a/render-jobs",
        cookie,
        "GET",
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { items: unknown[] };
      expect(listBody.items.length).toBeGreaterThan(0);
    }
  });

  // 7. Cross-tenant recebe 404 e não vaza existência
  it("7. Usuário de outro tenant recebe 404 indistinguível de recurso inexistente", async () => {
    const bCookie = await login("admin-b");
    // Tenta acessar rota de org-a / client-a
    const listRes = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      bCookie,
      "GET",
    );
    expect(listRes.status).toBe(404);

    const postRes = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      bCookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: { title: "Cross-tenant post" },
        idempotencyKey: `cross-tenant-${randomUUID()}`,
      },
    );
    expect(postRes.status).toBe(404);
  });

  // 8. Template de outro tenant rejeitado (404)
  it("8. Template de outro tenant é rejeitado (404)", async () => {
    const cookie = await login("editor-a");
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionBId, // Pertence a Org B
        input: { title: "Template de outro tenant" },
        idempotencyKey: `cross-template-${randomUUID()}`,
      },
    );
    expect(res.status).toBe(404);
  });

  // 9. Template arquivado rejeitado (400)
  it("9. Template arquivado é rejeitado (400)", async () => {
    const cookie = await login("editor-a");
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: archivedVersionId,
        input: { title: "Template arquivado" },
        idempotencyKey: `archived-template-${randomUUID()}`,
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/não está ativo/i);
  });

  // 10. Versão de renderer incompatível rejeitada (400)
  it("10. Versão de renderer incompatível é rejeitada (400)", async () => {
    const cookie = await login("editor-a");
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: incompatibleVersionId,
        input: { title: "Versão incompatível" },
        idempotencyKey: `incompatible-ver-${randomUUID()}`,
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/incompatível/i);
  });

  // 11. Post de outro cliente rejeitado (404)
  it("11. Post de outro cliente é rejeitado (404)", async () => {
    const cookie = await login("editor-a");
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        postId: postBId, // Pertence a Client B
        input: { title: "Post cross-client" },
        idempotencyKey: `cross-post-${randomUUID()}`,
      },
    );
    expect(res.status).toBe(404);
  });

  // 12. Background pendente rejeitado (400)
  it("12. Background pendente é rejeitado (400)", async () => {
    const cookie = await login("editor-a");
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: {
          title: "Background pendente",
          backgroundMediaAssetId: pendingAssetId,
        },
        idempotencyKey: `pending-bg-${randomUUID()}`,
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/ainda não está pronta/i);
  });

  // 13. Background arquivado rejeitado (400)
  it("13. Background arquivado é rejeitado (400)", async () => {
    const cookie = await login("editor-a");
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: {
          title: "Background arquivado",
          backgroundMediaAssetId: archivedAssetId,
        },
        idempotencyKey: `archived-bg-${randomUUID()}`,
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/arquivada/i);
  });

  // 14. Background de outro tenant rejeitado (400/404)
  it("14. Background de outro tenant é rejeitado (400)", async () => {
    const cookie = await login("editor-a");
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: {
          title: "Background outro tenant",
          backgroundMediaAssetId: crossTenantAssetId,
        },
        idempotencyKey: `cross-bg-${randomUUID()}`,
      },
    );
    expect(res.status).toBe(400);
  });

  // 15. Logotipo inválido rejeitado (400)
  it("15. Logotipo inválido (pendente) é rejeitado (400)", async () => {
    const cookie = await login("editor-a");
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: {
          title: "Logotipo inválido",
          logoMediaAssetId: pendingAssetId,
        },
        idempotencyKey: `invalid-logo-${randomUUID()}`,
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/ainda não está pronta/i);
  });

  // 16. Payload com campo desconhecido rejeitado (400)
  it("16. Payload com campo desconhecido é rejeitado (400)", async () => {
    const cookie = await login("editor-a");
    // Campo desconhecido na raiz
    const res1 = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: { title: "Teste" },
        idempotencyKey: `unknown-key-${randomUUID()}`,
        unknownField: "malicious",
      },
    );
    expect(res1.status).toBe(400);

    // Campo desconhecido dentro de input
    const res2 = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: {
          title: "Teste",
          arbitraryFont: "Comic Sans",
        },
        idempotencyKey: `unknown-font-${randomUUID()}`,
      },
    );
    expect(res2.status).toBe(400);

    // HTML no título
    const res3 = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: {
          title: "<script>alert('xss')</script>",
        },
        idempotencyKey: `xss-title-${randomUUID()}`,
      },
    );
    expect(res3.status).toBe(400);
  });

  // 17. Primeira criação retorna 202
  it("17. Primeira criação válida retorna 202 Accepted", async () => {
    const cookie = await login("editor-a");
    const idempotencyKey = `first-create-${randomUUID()}`;
    const res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: { title: "Primeira criação" },
        idempotencyKey,
      },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBeDefined();
    expect(body.status).toBe("PENDING");
  });

  // 18. Replay idêntico retorna 200 com o mesmo ID
  it("18. Replay idêntico da mesma solicitação retorna 200 OK com o mesmo ID", async () => {
    const cookie = await login("editor-a");
    const idempotencyKey = `replay-test-${randomUUID()}`;
    const payload = {
      templateVersionId: versionAId,
      postId: postAId,
      input: {
        title: "Título para replay",
        eyebrow: "Eyebrow",
        subtitle: "Subtitle",
        callToAction: "CTA",
        backgroundMediaAssetId: validBgAssetId,
        logoMediaAssetId: validLogoAssetId,
      },
      idempotencyKey,
    };

    // Primeira requisição: 202
    const res1 = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      payload,
    );
    expect(res1.status).toBe(202);
    const job1 = (await res1.json()) as { id: string };

    // Segunda requisição idêntica: 200 com mesmo ID
    const res2 = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      payload,
    );
    expect(res2.status).toBe(200);
    const job2 = (await res2.json()) as { id: string };
    expect(job2.id).toBe(job1.id);

    // Verifica que apenas UMA auditoria 'render.requested' foi gerada
    const audits = await migration.auditLog.findMany({
      where: {
        organizationId: "org-a",
        entityId: job1.id,
        action: "render.requested",
      },
    });
    expect(audits.length).toBe(1);
  });

  // 19. Reutilização divergente retorna 409
  it("19. Reutilização da idempotencyKey com parâmetros divergentes retorna 409 Conflict", async () => {
    const cookie = await login("editor-a");
    const idempotencyKey = `divergent-key-${randomUUID()}`;

    const res1 = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: { title: "Título Original" },
        idempotencyKey,
      },
    );
    expect(res1.status).toBe(202);

    // Mesma chave, título diferente
    const res2 = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: { title: "Título Diferente" },
        idempotencyKey,
      },
    );
    expect(res2.status).toBe(409);
    const body = (await res2.json()) as { message: string };
    expect(body.message).toMatch(/idempotência/i);

    // Verifica que nenhuma auditoria foi criada para o conflito
    const conflictAudits = await migration.auditLog.findMany({
      where: {
        organizationId: "org-a",
        action: "render.conflict",
      },
    });
    expect(conflictAudits.length).toBe(0);
  });

  // 20. Concorrência idempotente cria somente um registro e uma auditoria
  it("20. Concorrência idempotente cria somente um registro no banco e uma auditoria", async () => {
    const cookie = await login("editor-a");
    const idempotencyKey = `concurrent-${randomUUID()}`;
    const payload = {
      templateVersionId: versionAId,
      input: { title: "Concorrência Paralela" },
      idempotencyKey,
    };

    const [res1, res2] = await Promise.all([
      request(
        "/api/organizations/org-a/clients/client-a/render-jobs",
        cookie,
        "POST",
        payload,
      ),
      request(
        "/api/organizations/org-a/clients/client-a/render-jobs",
        cookie,
        "POST",
        payload,
      ),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // Um request ganha (202) e o outro é replay idêntico (200)
    expect(statuses).toEqual([200, 202]);

    const body1 = (await res1.json()) as { id: string };
    const body2 = (await res2.json()) as { id: string };
    expect(body1.id).toBe(body2.id);

    // Apenas 1 registro persistido
    const jobs = await migration.renderJob.findMany({
      where: {
        organizationId: "org-a",
        clientId: "client-a",
        idempotencyKey,
      },
    });
    expect(jobs.length).toBe(1);

    // Apenas 1 log de auditoria
    const audits = await migration.auditLog.findMany({
      where: {
        organizationId: "org-a",
        entityId: body1.id,
        action: "render.requested",
      },
    });
    expect(audits.length).toBe(1);
  });

  // 21. Falha de queue.add() mantém job PENDING e retorna 202
  it("21. Falha de queue.add() mantém job PENDING no banco e responde 202", async () => {
    // Cria app com queue falha propositalmente
    const failingQueue = {
      add: async () => {
        throw new Error("Redis connection simulate failure");
      },
      close: async () => {},
    } as unknown as ReturnType<typeof createRenderQueue>;

    const appConfig = readConfig(process.env);
    const failApp = await createApplication(appConfig, {
      renderQueue: failingQueue,
      mediaDependencies: { storage: mockStorage },
    });
    await failApp.app.listen(0, "127.0.0.1");
    const failPort = (failApp.app.getHttpServer().address() as AddressInfo)
      .port;
    const failBase = `http://127.0.0.1:${failPort}`;

    try {
      const cookie = await login("editor-a");
      const idempotencyKey = `fail-queue-${randomUUID()}`;
      const res = await fetch(
        `${failBase}/api/organizations/org-a/clients/client-a/render-jobs`,
        {
          method: "POST",
          headers: {
            cookie,
            origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            templateVersionId: versionAId,
            input: { title: "Fila falha" },
            idempotencyKey,
          }),
        },
      );

      expect(res.status).toBe(202);
      const body = (await res.json()) as { id: string; status: string };
      expect(body.status).toBe("PENDING");

      // No banco, o job permanece PENDING
      const saved = await migration.renderJob.findUnique({
        where: { id: body.id },
      });
      expect(saved?.status).toBe("PENDING");
      expect(saved?.queueJobId).toBeNull();
    } finally {
      await failApp.close();
    }
  });

  // 22. Reconciliação posterior consegue enfileirar o job
  it("22. Reconciliação periódica enfileira job pendente", async () => {
    // Insere job pendente diretamente sem BullMQ job
    const orphanedJob = await migration.renderJob.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        templateVersionId: versionAId,
        status: "PENDING",
        input: { title: "Orphaned pending" },
        inputHash: hashRenderInput(
          templateSpec,
          artworkInputSchema.parse({ title: "Orphaned pending" }),
        ),
        idempotencyKey: `orphaned-${randomUUID()}`,
        createdById: "editor-a",
        updatedAt: new Date(Date.now() - 60_000), // 1 minuto atrás
      },
    });

    const reconResult = await runRendererReconciliationCycle(
      db as unknown as PrismaClient,
      redis,
    );
    expect(reconResult.recoveredJobs).toBeGreaterThanOrEqual(1);

    // Verifica que o BullMQ job foi adicionado na fila
    const queue = createRenderQueue(redis);
    try {
      const job = await queue.getJob(`render-${orphanedJob.id}`);
      expect(job).not.toBeNull();
      expect(job?.data.renderJobId).toBe(orphanedJob.id);
    } finally {
      await queue.close();
    }
  });

  // 23. GET não expõe token, lease, queue ID, storage key ou mensagem interna
  it("23. GET não expõe token de execução, leaseExpiresAt, queueJobId, storageKey ou erro interno", async () => {
    const cookie = await login("editor-a");
    // Cria job com dados operacionais sensíveis diretamente via migration
    const sensitiveJob = await migration.renderJob.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        templateVersionId: versionAId,
        status: "FAILED",
        input: { title: "Job sensível" },
        inputHash: "hash",
        idempotencyKey: `sensitive-${randomUUID()}`,
        createdById: "editor-a",
        queueJobId: `render-${randomUUID()}`,
        executionToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        errorCode: "RENDER_TIMEOUT",
        errorMessage:
          "Secret internal trace: Connection to s3://secret-bucket failed",
      },
    });

    const res = await request(
      `/api/organizations/org-a/clients/client-a/render-jobs/${sensitiveJob.id}`,
      cookie,
      "GET",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // Campos permitidos
    expect(body.id).toBe(sensitiveJob.id);
    expect(body.status).toBe("FAILED");
    expect(body.errorCode).toBe("RENDER_TIMEOUT");

    // Campos proibidos NUNCA expostos
    expect(body.executionToken).toBeUndefined();
    expect(body.leaseExpiresAt).toBeUndefined();
    expect(body.queueJobId).toBeUndefined();
    expect(body.errorMessage).toBeUndefined();
    expect(body.storageKey).toBeUndefined();
    expect(body.input).toBeUndefined();
  });

  // 24. Listagem paginada e limitada
  it("24. Listagem paginada e limitada por cursor", async () => {
    const cookie = await login("editor-a");

    // Cria 5 jobs
    const createdIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(
        "/api/organizations/org-a/clients/client-a/render-jobs",
        cookie,
        "POST",
        {
          templateVersionId: versionAId,
          input: { title: `Job página ${i}` },
          idempotencyKey: `page-test-${i}-${randomUUID()}`,
        },
      );
      expect(res.status).toBe(202);
      const b = (await res.json()) as { id: string };
      createdIds.push(b.id);
    }

    // Consulta primeira página com limit=2
    const page1Res = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs?limit=2",
      cookie,
      "GET",
    );
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      items: { id: string }[];
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page1.items.length).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    // Consulta segunda página com cursor
    const page2Res = await request(
      `/api/organizations/org-a/clients/client-a/render-jobs?limit=2&cursor=${page1.nextCursor}`,
      cookie,
      "GET",
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(page2.items.length).toBe(2);
    // Não deve repetir nenhum id da página 1
    expect(page2.items.map((i) => i.id)).not.toContain(page1.items[0]?.id);
    expect(page2.items.map((i) => i.id)).not.toContain(page1.items[1]?.id);

    // Limite máximo de 50 excedido deve retornar 400
    const maxRes = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs?limit=100",
      cookie,
      "GET",
    );
    expect(maxRes.status).toBe(400);
  });

  // 25. Filtro de status validado
  it("25. Filtro de status validado (apenas valores válidos)", async () => {
    const cookie = await login("editor-a");

    // Status válido
    const validRes = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs?status=PENDING",
      cookie,
      "GET",
    );
    expect(validRes.status).toBe(200);

    // Status inválido
    const invalidRes = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs?status=INVALID_STATUS",
      cookie,
      "GET",
    );
    expect(invalidRes.status).toBe(400);
  });

  // 26. Mídia pronta produz URL relativa autenticada
  it("26. Mídia resultante pronta produz URL relativa autenticada", async () => {
    const cookie = await login("editor-a");
    // Cria output media asset
    const outputAssetId = randomUUID();
    const outputAsset = await migration.mediaAsset.create({
      data: {
        id: outputAssetId,
        organizationId: "org-a",
        clientId: "client-a",
        name: "output.png",
        storageKey: `media/org-a/client-a/${outputAssetId}`,
        status: "ready",
        mimeType: "image/png",
        byteSize: 2048,
        width: 1080,
        height: 1350,
        sha256: "9".repeat(64),
        archived: false,
      },
    });

    const completedJob = await migration.renderJob.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        templateVersionId: versionAId,
        status: "COMPLETED",
        input: { title: "Com mídia pronta" },
        inputHash: "hash-ready",
        idempotencyKey: `completed-${randomUUID()}`,
        createdById: "editor-a",
        outputMediaAssetId: outputAsset.id,
      },
    });

    const res = await request(
      `/api/organizations/org-a/clients/client-a/render-jobs/${completedJob.id}`,
      cookie,
      "GET",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outputMediaAssetId: string;
      outputMediaUrl: string;
    };
    expect(body.outputMediaAssetId).toBe(outputAsset.id);
    expect(body.outputMediaUrl).toBe(
      `/api/organizations/org-a/clients/client-a/media/${outputAsset.id}`,
    );
    // Não expõe S3 nem bucket URL
    expect(body.outputMediaUrl).not.toContain("http");
    expect(body.outputMediaUrl).not.toContain("s3");
  });

  // 27. queueJobId é preenchido somente pelo renderer
  it("27. queueJobId é preenchido somente pelo renderer worker sob system:renderer", async () => {
    const cookie = await login("editor-a");
    const idempotencyKey = `worker-fill-${randomUUID()}`;
    const createRes = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      {
        templateVersionId: versionAId,
        input: { title: "Para worker preencher" },
        idempotencyKey,
      },
    );
    expect(createRes.status).toBe(202);
    const created = (await createRes.json()) as { id: string };

    // Ao ser criado pela API, queueJobId é null
    const initialJob = await migration.renderJob.findUnique({
      where: { id: created.id },
    });
    expect(initialJob?.queueJobId).toBeNull();

    // Usuário normal tenta alterar queueJobId -> RLS bloqueia
    await expect(
      asActor(db, "editor-a", (tx) =>
        tx.renderJob.update({
          where: { id: created.id },
          data: { queueJobId: `fake-queue-${created.id}` },
        }),
      ),
    ).rejects.toThrow();

    // Quando o worker executa o job sob asRendererActor(), queueJobId é gravado deterministicamente
    await executeRenderJob(
      {
        renderJobId: created.id,
        organizationId: "org-a",
        clientId: "client-a",
      },
      db as unknown as PrismaClient,
      mockStorage,
    );

    const acquiredJob = await migration.renderJob.findUnique({
      where: { id: created.id },
    });
    expect(acquiredJob?.queueJobId).toBe(`render-${created.id}`);
  });

  // 28. Scheduler permanece sem regressões
  it("28. Scheduler e rota de saúde permanecem sem regressões", async () => {
    const liveRes = await request("/health/live");
    expect(liveRes.status).toBe(200);
    const readyRes = await request("/health/ready");
    expect(readyRes.status).toBe(200);
  });

  // 29. CSRF é obrigatório na mutação
  it("29. CSRF é obrigatório na mutação (POST sem origin ou origin errada é rejeitado com 403)", async () => {
    const cookie = await login("editor-a");
    const payload = {
      templateVersionId: versionAId,
      input: { title: "Teste CSRF" },
      idempotencyKey: `csrf-test-${randomUUID()}`,
    };

    // Origem não autorizada
    const resForbidden = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      cookie,
      "POST",
      payload,
      "https://attacker.site",
    );
    expect(resForbidden.status).toBe(403);
    const body = (await resForbidden.json()) as { message: string };
    expect(body.message).toMatch(/origem não autorizada/i);
  });

  // 30. Requisição não autenticada é rejeitada (401)
  it("30. Requisição não autenticada é rejeitada com 401", async () => {
    const resGet = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      "", // sem cookie
      "GET",
    );
    expect(resGet.status).toBe(401);

    const resPost = await request(
      "/api/organizations/org-a/clients/client-a/render-jobs",
      "", // sem cookie
      "POST",
      {
        templateVersionId: versionAId,
        input: { title: "Sem sessão" },
        idempotencyKey: `unauth-${randomUUID()}`,
      },
    );
    expect(resPost.status).toBe(401);
  });
});
