import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createDatabase } from "../../packages/db/src/index.js";
import { readConfig } from "../../packages/config/src/index.js";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { createApplication } from "../../apps/api/dist/app.js";
import { RENDERER_VERSION } from "../../packages/render/src/index.js";
import type { MediaStorage } from "../../apps/api/src/media-storage.js";

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

describe("Phase 6 Increment 3: Render Batch API", () => {
  let redis: Redis;
  let appRuntime: Awaited<ReturnType<typeof createApplication>>;
  let apiBase: string;
  const origin = process.env.APP_URL!;
  const password = process.env.DEV_SEED_PASSWORD!;

  // Fixtures
  let templateAId: string;
  let versionAId: string;
  let templateBId: string;
  let versionBId: string;
  let post1Id: string;
  let post2Id: string;
  let postWithScriptId: string;
  let postCrossTenantId: string;
  let createdBatchId: string;

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

    // 1. Template & Version Org A, Client A
    const tA = await migration.designTemplate.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        name: `Batch Template A ${randomUUID()}`,
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

    // 2. Template Org B, Client B
    const tB = await migration.designTemplate.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        name: `Batch Template B ${randomUUID()}`,
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

    // 3. Posts no Client A
    const p1 = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        title: "Dica de Produtividade #1",
        caption:
          "Aprenda a focar no essencial para produzir mais em menos tempo.",
        callToAction: "Salve para ler depois",
        status: "APPROVED",
      },
    });
    post1Id = p1.id;

    const p2 = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        title: "Dica de Produtividade #2",
        caption: "Organize sua rotina diária com blocos de tempo eficientes.",
        callToAction: "Compartilhe com a equipe",
        status: "APPROVED",
      },
    });
    post2Id = p2.id;

    const pScript = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        title: "Injeção Suspeita",
        caption: "<script>alert('xss')</script> Conteúdo malicioso proibido.",
        callToAction: "Clique aqui",
        status: "DRAFT",
      },
    });
    postWithScriptId = pScript.id;

    // 4. Post no Client B (cross-tenant)
    const pB = await migration.post.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        title: "Post Org B",
        caption: "Conteúdo isolado de outro cliente.",
        status: "APPROVED",
      },
    });
    postCrossTenantId = pB.id;
  });

  afterAll(async () => {
    await migration.auditLog.deleteMany({
      where: { action: { startsWith: "batch." } },
    });
    await migration.renderJob.deleteMany({});
    await migration.renderBatch.deleteMany({});
    await migration.post.deleteMany({
      where: {
        id: { in: [post1Id, post2Id, postWithScriptId, postCrossTenantId] },
      },
    });
    await migration.designTemplateVersion.deleteMany({
      where: { id: { in: [versionAId, versionBId] } },
    });
    await migration.designTemplate.deleteMany({
      where: { id: { in: [templateAId, templateBId] } },
    });

    if (appRuntime) {
      await appRuntime.close();
    }
    if (redis) {
      await redis.quit();
    }
    await db.$disconnect();
    await migration.$disconnect();
  });

  beforeEach(async () => {
    await migration.rateLimit.deleteMany();
  });

  describe("1. POST /render-batches/validate (Dry-run)", () => {
    it("deve rejeitar com 400 requisições com schema Zod inválido", async () => {
      const cookie = await login("admin-a");
      const res = await request(
        "/api/organizations/org-a/clients/client-a/render-batches/validate",
        cookie,
        "POST",
        {
          templateVersionId: "invalid-uuid",
        },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.message).toContain("inválidos");
    });

    it("deve rejeitar com 404 se templateVersionId for de outro tenant", async () => {
      const cookie = await login("admin-a");
      const res = await request(
        "/api/organizations/org-a/clients/client-a/render-batches/validate",
        cookie,
        "POST",
        {
          templateVersionId: versionBId,
          format: "PORTRAIT",
          source: {
            type: "POSTS_SELECTION",
            postIds: [post1Id],
          },
        },
      );
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.message).toBe("Template de design não encontrado.");
    });

    it("deve retornar 200 com resumo identificando posts válidos e inválidos", async () => {
      const cookie = await login("editor-a");
      const res = await request(
        "/api/organizations/org-a/clients/client-a/render-batches/validate",
        cookie,
        "POST",
        {
          templateVersionId: versionAId,
          format: "PORTRAIT",
          source: {
            type: "POSTS_SELECTION",
            postIds: [post1Id, postWithScriptId],
          },
        },
      );
      expect(res.status).toBe(200);
      const report = await res.json();
      expect(report.totalRequested).toBe(2);
      expect(report.validItemsCount).toBe(1);
      expect(report.invalidItemsCount).toBe(1);
      expect(report.valid).toBe(false);

      expect(report.validItems).toHaveLength(1);
      expect(report.validItems[0]?.postId).toBe(post1Id);

      expect(report.invalidItems).toHaveLength(1);
      expect(report.invalidItems[0]?.postId).toBe(postWithScriptId);
      expect(report.invalidItems[0]?.reasons[0]).toContain(
        "conteúdo não permitido",
      );
    });

    it("deve rejeitar com 403 para perfil CLIENT_VIEWER", async () => {
      const cookie = await login("viewer-a");
      const res = await request(
        "/api/organizations/org-a/clients/client-a/render-batches/validate",
        cookie,
        "POST",
        {
          templateVersionId: versionAId,
          format: "PORTRAIT",
          source: {
            type: "POSTS_SELECTION",
            postIds: [post1Id],
          },
        },
      );
      expect(res.status).toBe(403);
    });
  });

  describe("2. POST /render-batches (Criação Idempotente)", () => {
    it("deve criar um lote com sucesso e persistir RenderBatch e RenderJobs em PENDING", async () => {
      const cookie = await login("editor-a");
      const idempotencyKey = `batch-create-test-${randomUUID()}`;

      const res = await request(
        "/api/organizations/org-a/clients/client-a/render-batches",
        cookie,
        "POST",
        {
          templateVersionId: versionAId,
          format: "PORTRAIT",
          source: {
            type: "POSTS_SELECTION",
            postIds: [post1Id, post2Id],
          },
          idempotencyKey,
        },
      );

      expect([201, 202]).toContain(res.status);
      const batch = await res.json();
      expect(batch.id).toBeDefined();
      expect(batch.status).toBe("PENDING");
      expect(batch.totalItems).toBe(2);
      expect(batch.pendingItems).toBe(2);
      expect(batch.completedItems).toBe(0);
      expect(batch.failedItems).toBe(0);
      expect(batch.cancelledItems).toBe(0);
      expect(batch.format).toBe("PORTRAIT");

      // Verificar persistência no banco
      const dbJobs = await migration.renderJob.findMany({
        where: { batchId: batch.id },
        orderBy: { createdAt: "asc" },
      });
      expect(dbJobs).toHaveLength(2);
      expect(dbJobs[0]?.postId).toBe(post1Id);
      expect(dbJobs[0]?.status).toBe("PENDING");
      expect(dbJobs[1]?.postId).toBe(post2Id);
      expect(dbJobs[1]?.status).toBe("PENDING");

      // Testar replay com mesma idempotencyKey -> 200 OK idêntico
      const replayRes = await request(
        "/api/organizations/org-a/clients/client-a/render-batches",
        cookie,
        "POST",
        {
          templateVersionId: versionAId,
          format: "PORTRAIT",
          source: {
            type: "POSTS_SELECTION",
            postIds: [post1Id, post2Id],
          },
          idempotencyKey,
        },
      );
      expect(replayRes.status).toBe(200);
      const replayBatch = await replayRes.json();
      expect(replayBatch.id).toBe(batch.id);

      // Quantidade de jobs no banco não pode ter aumentado
      const totalJobs = await migration.renderJob.count({
        where: { batchId: batch.id },
      });
      expect(totalJobs).toBe(2);
    });

    it("deve retornar 409 Conflict se mesma idempotencyKey for enviada com parâmetros divergentes", async () => {
      const cookie = await login("admin-a");
      const idempotencyKey = `batch-conflict-test-${randomUUID()}`;

      // Primeira criação
      const res1 = await request(
        "/api/organizations/org-a/clients/client-a/render-batches",
        cookie,
        "POST",
        {
          templateVersionId: versionAId,
          format: "PORTRAIT",
          source: {
            type: "POSTS_SELECTION",
            postIds: [post1Id],
          },
          idempotencyKey,
        },
      );
      expect([201, 202]).toContain(res1.status);

      // Segunda criação com parâmetros diferentes
      const res2 = await request(
        "/api/organizations/org-a/clients/client-a/render-batches",
        cookie,
        "POST",
        {
          templateVersionId: versionAId,
          format: "PORTRAIT",
          source: {
            type: "POSTS_SELECTION",
            postIds: [post2Id],
          },
          idempotencyKey,
        },
      );
      expect(res2.status).toBe(409);
      const json = await res2.json();
      expect(json.message).toContain("Conflito de idempotência");
    });

    it("deve rejeitar 422 se lote contiver post inválido", async () => {
      const cookie = await login("admin-a");
      const res = await request(
        "/api/organizations/org-a/clients/client-a/render-batches",
        cookie,
        "POST",
        {
          templateVersionId: versionAId,
          format: "PORTRAIT",
          source: {
            type: "POSTS_SELECTION",
            postIds: [postWithScriptId],
          },
          idempotencyKey: `batch-invalid-${randomUUID()}`,
        },
      );
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.message).toContain("não permitido");
    });

    it("deve rejeitar 403 para perfil CLIENT_VIEWER", async () => {
      const cookie = await login("viewer-a");
      const res = await request(
        "/api/organizations/org-a/clients/client-a/render-batches",
        cookie,
        "POST",
        {
          templateVersionId: versionAId,
          format: "PORTRAIT",
          source: {
            type: "POSTS_SELECTION",
            postIds: [post1Id],
          },
          idempotencyKey: `batch-viewer-${randomUUID()}`,
        },
      );
      expect(res.status).toBe(403);
    });
  });

  describe("3. GET /render-batches e /render-batches/:batchId", () => {
    beforeAll(async () => {
      const cookie = await login("admin-a");
      const res = await request(
        "/api/organizations/org-a/clients/client-a/render-batches",
        cookie,
        "POST",
        {
          templateVersionId: versionAId,
          format: "PORTRAIT",
          source: {
            type: "POSTS_SELECTION",
            postIds: [post1Id],
          },
          idempotencyKey: `batch-query-setup-${randomUUID()}`,
        },
      );
      const json = await res.json();
      createdBatchId = json.id;
    });

    it("deve listar os lotes paginados para usuários autorizados (incluindo viewer)", async () => {
      const cookie = await login("viewer-a");
      const res = await request(
        "/api/organizations/org-a/clients/client-a/render-batches?limit=10",
        cookie,
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.batches).toBeInstanceOf(Array);
      expect(data.batches.length).toBeGreaterThanOrEqual(1);
      const found = data.batches.find(
        (b: { id: string }) => b.id === createdBatchId,
      );
      expect(found).toBeDefined();
    });

    it("deve consultar detalhes do lote por ID", async () => {
      const cookie = await login("viewer-a");
      const res = await request(
        `/api/organizations/org-a/clients/client-a/render-batches/${createdBatchId}`,
        cookie,
      );
      expect(res.status).toBe(200);
      const batch = await res.json();
      expect(batch.id).toBe(createdBatchId);
      expect(batch.totalItems).toBe(1);
    });

    it("deve listar os itens do lote em /items", async () => {
      const cookie = await login("viewer-a");
      const res = await request(
        `/api/organizations/org-a/clients/client-a/render-batches/${createdBatchId}/items`,
        cookie,
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.items).toBeInstanceOf(Array);
      expect(data.items.length).toBe(1);
      expect(data.items[0]?.postId).toBe(post1Id);
    });

    it("deve impedir acesso cruzado de outro tenant (retornando 404)", async () => {
      const cookie = await login("admin-b");
      // Tentativa de acessar lote da org-a usando a rota da org-b/client-b
      const res = await request(
        `/api/organizations/org-b/clients/client-b/render-batches/${createdBatchId}`,
        cookie,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("4. POST /render-batches/:batchId/cancel (Cancelamento Cooperativo)", () => {
    it("deve cancelar lote em PENDING e mover seus jobs para CANCELLED", async () => {
      const cookie = await login("admin-a");
      // Cria lote com 2 posts
      const createRes = await request(
        "/api/organizations/org-a/clients/client-a/render-batches",
        cookie,
        "POST",
        {
          templateVersionId: versionAId,
          format: "PORTRAIT",
          source: {
            type: "POSTS_SELECTION",
            postIds: [post1Id, post2Id],
          },
          idempotencyKey: `batch-cancel-test-${randomUUID()}`,
        },
      );
      const batch = await createRes.json();
      const batchId = batch.id;

      // Executa cancelamento
      const cancelRes = await request(
        `/api/organizations/org-a/clients/client-a/render-batches/${batchId}/cancel`,
        cookie,
        "POST",
      );
      expect(cancelRes.status).toBe(200);
      const cancelledBatch = await cancelRes.json();
      expect(cancelledBatch.status).toBe("CANCELLED");
      expect(cancelledBatch.pendingItems).toBe(0);
      expect(cancelledBatch.cancelledItems).toBe(2);
      expect(cancelledBatch.cancelRequestedAt).toBeDefined();
      expect(cancelledBatch.cancelCompletedAt).toBeDefined();

      // Verificar status dos jobs no banco
      const jobs = await migration.renderJob.findMany({
        where: { batchId },
      });
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(job.status).toBe("CANCELLED");
      }

      // Repetição do cancelamento deve ser idempotente
      const repeatCancelRes = await request(
        `/api/organizations/org-a/clients/client-a/render-batches/${batchId}/cancel`,
        cookie,
        "POST",
      );
      expect(repeatCancelRes.status).toBe(200);
      const repeatData = await repeatCancelRes.json();
      expect(repeatData.status).toBe("CANCELLED");
    });

    it("deve rejeitar cancelamento por CLIENT_VIEWER com 403", async () => {
      const adminCookie = await login("admin-a");
      const createRes = await request(
        "/api/organizations/org-a/clients/client-a/render-batches",
        adminCookie,
        "POST",
        {
          templateVersionId: versionAId,
          format: "PORTRAIT",
          source: {
            type: "POSTS_SELECTION",
            postIds: [post1Id],
          },
          idempotencyKey: `batch-cancel-viewer-${randomUUID()}`,
        },
      );
      const batch = await createRes.json();

      const viewerCookie = await login("viewer-a");
      const cancelRes = await request(
        `/api/organizations/org-a/clients/client-a/render-batches/${batch.id}/cancel`,
        viewerCookie,
        "POST",
      );
      expect(cancelRes.status).toBe(403);
    });
  });

  describe("5. POST /render-batches/:batchId/retry-failed (Repetição Segura de Itens Falhos)", () => {
    it("deve criar lote derivado com parentBatchId contendo somente os itens FAILED", async () => {
      const cookie = await login("editor-a");

      // 1. Criar lote original com 2 posts
      const createRes = await request(
        "/api/organizations/org-a/clients/client-a/render-batches",
        cookie,
        "POST",
        {
          templateVersionId: versionAId,
          format: "PORTRAIT",
          source: {
            type: "POSTS_SELECTION",
            postIds: [post1Id, post2Id],
          },
          idempotencyKey: `batch-for-retry-${randomUUID()}`,
        },
      );
      expect([201, 202]).toContain(createRes.status);
      const originalBatch = await createRes.json();
      const originalBatchId = originalBatch.id;

      // 2. Simular que o primeiro job completou e o segundo falhou
      const jobs = await migration.renderJob.findMany({
        where: { batchId: originalBatchId },
        orderBy: { createdAt: "asc" },
      });
      expect(jobs).toHaveLength(2);

      await migration.renderJob.update({
        where: { id: jobs[0]!.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      await migration.renderJob.update({
        where: { id: jobs[1]!.id },
        data: { status: "FAILED", errorCode: "RENDER_ERROR" },
      });
      await migration.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT set_config('app.user_id', 'system:renderer', true)
        `;
        await tx.renderBatch.update({
          where: { id: originalBatchId },
          data: {
            pendingItems: 0,
            completedItems: 1,
            failedItems: 1,
            status: "PARTIALLY_FAILED",
          },
        });
      });

      // 3. Executar retry-failed
      const retryIdempKey = `retry-idemp-${randomUUID()}`;
      const retryRes = await request(
        `/api/organizations/org-a/clients/client-a/render-batches/${originalBatchId}/retry-failed`,
        cookie,
        "POST",
        { idempotencyKey: retryIdempKey },
      );
      expect([201, 202]).toContain(retryRes.status);
      const derivedBatch = await retryRes.json();

      expect(derivedBatch.id).not.toBe(originalBatchId);
      expect(derivedBatch.parentBatchId).toBe(originalBatchId);
      expect(derivedBatch.totalItems).toBe(1);
      expect(derivedBatch.pendingItems).toBe(1);
      expect(derivedBatch.failedItems).toBe(0);
      expect(derivedBatch.status).toBe("PENDING");

      // 4. Conferir que no banco o derivedBatch tem exatamente 1 job (referente ao post que falhou)
      const derivedJobs = await migration.renderJob.findMany({
        where: { batchId: derivedBatch.id },
      });
      expect(derivedJobs).toHaveLength(1);
      expect(derivedJobs[0]!.postId).toBe(post2Id);

      // 5. Testar replay idempotente de retry-failed
      const replayRetryRes = await request(
        `/api/organizations/org-a/clients/client-a/render-batches/${originalBatchId}/retry-failed`,
        cookie,
        "POST",
        { idempotencyKey: retryIdempKey },
      );
      expect(replayRetryRes.status).toBe(200);
      const replayBatch = await replayRetryRes.json();
      expect(replayBatch.id).toBe(derivedBatch.id);

      // 6. Testar rejeição para CLIENT_VIEWER
      const viewerCookie = await login("viewer-a");
      const viewerRetryRes = await request(
        `/api/organizations/org-a/clients/client-a/render-batches/${originalBatchId}/retry-failed`,
        viewerCookie,
        "POST",
        { idempotencyKey: `retry-viewer-${randomUUID()}` },
      );
      expect(viewerRetryRes.status).toBe(403);
    });

    it("deve retornar 404 ao tentar retry-failed em lote de outro tenant", async () => {
      const cookieB = await login("admin-b");
      const res = await request(
        `/api/organizations/org-b/clients/client-b/render-batches/${createdBatchId}/retry-failed`,
        cookieB,
        "POST",
        { idempotencyKey: `retry-cross-${randomUUID()}` },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("6. Resiliência de Concorrência e Ausência de Vazamento de Segredos", () => {
    it("deve tratar corrida concorrente de criação retornando o mesmo lote e sem duplicar jobs", async () => {
      const cookie = await login("admin-a");
      const sharedIdempKey = `race-create-${randomUUID()}`;

      const payload = {
        templateVersionId: versionAId,
        format: "PORTRAIT",
        source: {
          type: "POSTS_SELECTION",
          postIds: [post1Id],
        },
        idempotencyKey: sharedIdempKey,
      };

      // Dispara 2 requisições em paralelo
      const [res1, res2] = await Promise.all([
        request(
          "/api/organizations/org-a/clients/client-a/render-batches",
          cookie,
          "POST",
          payload,
        ),
        request(
          "/api/organizations/org-a/clients/client-a/render-batches",
          cookie,
          "POST",
          payload,
        ),
      ]);

      expect([200, 201, 202]).toContain(res1.status);
      expect([200, 201, 202]).toContain(res2.status);

      const batch1 = await res1.json();
      const batch2 = await res2.json();
      expect(batch1.id).toBe(batch2.id);

      // Total de lotes com essa chave deve ser exatamente 1
      const countBatches = await migration.renderBatch.count({
        where: { idempotencyKey: sharedIdempKey },
      });
      expect(countBatches).toBe(1);

      // Total de jobs desse lote deve ser exatamente 1
      const countJobs = await migration.renderJob.count({
        where: { batchId: batch1.id },
      });
      expect(countJobs).toBe(1);
    });

    it("não deve vazar credenciais ou segredos em respostas da API", async () => {
      const cookie = await login("editor-a");
      const res = await request(
        `/api/organizations/org-a/clients/client-a/render-batches/${createdBatchId}`,
        cookie,
      );
      expect(res.status).toBe(200);
      const text = await res.text();

      // Checa ausência de dados sensíveis
      expect(text).not.toContain("password");
      expect(text).not.toContain("secret");
      expect(text).not.toContain("MEDIA_S3_SECRET_ACCESS_KEY");
      expect(text).not.toContain("DATABASE_URL");
      expect(text).not.toContain("REDIS_PASSWORD");
    });
  });
});
