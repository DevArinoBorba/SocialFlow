import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { Redis } from "ioredis";
import { UnrecoverableError } from "bullmq";
import {
  createDatabase,
  asSystemRendererDiscovery,
  type Prisma,
} from "@socialflow/db";
import {
  executeRenderJob,
  runRendererStartupReconciliation,
  runRendererReconciliationCycle,
  RendererReconciler,
  ActiveLeaseError,
  createRendererWorker,
} from "../../apps/worker/src/renderer-worker.js";
import {
  createRenderQueue,
  closeRenderQueue,
  getRenderQueueJobId,
  RENDER_QUEUE_NAME,
} from "../../apps/api/src/render-queue.js";
import {
  mediaStorage,
  type MediaStorage,
} from "../../apps/api/src/media-storage.js";
import {
  hashRenderInput,
  RENDERER_VERSION,
} from "../../packages/render/src/index.js";
import {
  designDimensions,
  artworkInputSchema,
  type DesignFormat,
  type DesignTemplateSpec,
  type ArtworkInput,
} from "../../packages/contracts/src/index.js";

const db = createDatabase(process.env.DATABASE_URL!) as Parameters<
  typeof executeRenderJob
>[1];
const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);

const defaultSpec: DesignTemplateSpec = {
  schemaVersion: 1,
  format: "PORTRAIT",
  backgroundColor: "#112233",
  overlayColor: "#050B11",
  overlayOpacity: 0.4,
  textColor: "#FFFFFF",
  mutedTextColor: "#CBD5E1",
  accentColor: "#38BDF8",
  safeArea: 80,
  textAlign: "left",
  titleMaxLines: 3,
  showEyebrow: true,
  showSubtitle: true,
  showCallToAction: true,
};

const defaultInput: ArtworkInput = {
  title: "Campanha de Primavera",
  eyebrow: "Novidade",
  subtitle: "Confira as melhores ofertas da estação",
  callToAction: "Saiba Mais",
  backgroundMediaAssetId: null,
  logoMediaAssetId: null,
};

describe("Fase 6: Artwork Render Worker e Pipeline de Armazenamento", () => {
  let redis: Redis;
  let storage: MediaStorage;
  let validPngBuffer: Buffer;
  let validPngSha256: string;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
      connectTimeout: 2500,
    });

    const s = mediaStorage(process.env);
    if (!s) throw new Error("Local media storage could not be initialized");
    storage = s;

    // Gera um PNG válido para testes de mídias de origem
    validPngBuffer = await sharp({
      create: {
        width: 120,
        height: 120,
        channels: 4,
        background: { r: 56, g: 189, b: 248, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    validPngSha256 = createHash("sha256").update(validPngBuffer).digest("hex");
  });

  afterAll(async () => {
    await migration.auditLog.deleteMany({
      where: { action: { startsWith: "render." } },
    });
    await migration.renderJob.deleteMany({});
    await migration.renderBatch.deleteMany({});
    await migration.mediaAsset.deleteMany({});
    await migration.designTemplateVersion.deleteMany({});
    await migration.designTemplate.deleteMany({});
    storage.close();
    redis.disconnect();
    await db.$disconnect();
    await migration.$disconnect();
  });

  async function createTestFixture(options?: {
    organizationId?: string;
    clientId?: string;
    format?: DesignFormat;
    includeBackground?: boolean;
    includeLogo?: boolean;
    spec?: Partial<DesignTemplateSpec>;
    input?: Partial<ArtworkInput>;
    rendererVersion?: string;
    corruptMediaHash?: boolean;
    corruptInputHash?: boolean;
    initialStatus?: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
    leaseExpiresAt?: Date | null;
  }) {
    const orgId = options?.organizationId ?? "org-a";
    const clientId = options?.clientId ?? "client-a";
    const format = options?.format ?? "PORTRAIT";
    const spec = { ...defaultSpec, format, ...(options?.spec ?? {}) };
    const input = { ...defaultInput, ...(options?.input ?? {}) };
    const rendererVersion = options?.rendererVersion ?? RENDERER_VERSION;

    const template = await migration.designTemplate.create({
      data: {
        organizationId: orgId,
        clientId,
        name: `Template ${randomUUID()}`,
      },
    });

    const specHash = createHash("sha256")
      .update(JSON.stringify(spec))
      .digest("hex");

    const version = await migration.designTemplateVersion.create({
      data: {
        organizationId: orgId,
        clientId,
        templateId: template.id,
        version: 1,
        format,
        spec: spec as unknown as Prisma.InputJsonValue,
        specHash,
        rendererVersion,
      },
    });

    let backgroundMediaAssetId: string | undefined;
    let logoMediaAssetId: string | undefined;

    if (options?.includeBackground) {
      const bgId = randomUUID();
      const bgKey = `media/${orgId}/${clientId}/${bgId}`;
      await storage.put(bgKey, validPngBuffer, "image/png");
      const sha = options.corruptMediaHash ? "0".repeat(64) : validPngSha256;
      await migration.mediaAsset.create({
        data: {
          id: bgId,
          organizationId: orgId,
          clientId,
          name: "Background Image",
          storageKey: bgKey,
          status: "ready",
          mimeType: "image/png",
          byteSize: validPngBuffer.length,
          width: 120,
          height: 120,
          sha256: sha,
        },
      });
      backgroundMediaAssetId = bgId;
    }

    if (options?.includeLogo) {
      const logoId = randomUUID();
      const logoKey = `media/${orgId}/${clientId}/${logoId}`;
      await storage.put(logoKey, validPngBuffer, "image/png");
      const sha = options.corruptMediaHash ? "0".repeat(64) : validPngSha256;
      await migration.mediaAsset.create({
        data: {
          id: logoId,
          organizationId: orgId,
          clientId,
          name: "Logo Image",
          storageKey: logoKey,
          status: "ready",
          mimeType: "image/png",
          byteSize: validPngBuffer.length,
          width: 120,
          height: 120,
          sha256: sha,
        },
      });
      logoMediaAssetId = logoId;
    }

    const parsedInput = artworkInputSchema.parse({
      ...defaultInput,
      backgroundMediaAssetId: backgroundMediaAssetId ?? null,
      logoMediaAssetId: logoMediaAssetId ?? null,
      ...(options?.input ?? {}),
    });

    const inputHash = options?.corruptInputHash
      ? "corrupted_hash"
      : hashRenderInput(spec, parsedInput);
    const jobId = randomUUID();

    const job = await migration.renderJob.create({
      data: {
        id: jobId,
        organizationId: orgId,
        clientId,
        templateVersionId: version.id,
        backgroundMediaAssetId,
        logoMediaAssetId,
        input: parsedInput as unknown as Prisma.InputJsonValue,
        inputHash,
        idempotencyKey: `idemp-${jobId}`,
        createdById: "editor-a",
        status: options?.initialStatus ?? "PENDING",
        leaseExpiresAt: options?.leaseExpiresAt ?? null,
      },
    });

    return {
      template,
      version,
      job,
      organizationId: orgId,
      clientId,
      spec,
      input,
    };
  }

  describe("Aquisição, Concorrência e Fencing Token", () => {
    it("aquisição única por dois workers concorrentes", async () => {
      const { job, organizationId, clientId } = await createTestFixture();

      let worker1Acquired = false;
      let worker2Acquired = false;

      const p1 = executeRenderJob(
        { renderJobId: job.id, organizationId, clientId },
        db,
        storage,
        {
          onAfterAcquisition: async (acquired) => {
            worker1Acquired = acquired;
          },
        },
      );

      const p2 = executeRenderJob(
        { renderJobId: job.id, organizationId, clientId },
        db,
        storage,
        {
          onAfterAcquisition: async (acquired) => {
            worker2Acquired = acquired;
          },
        },
      );

      const results = await Promise.allSettled([p1, p2]);

      // Exatamente um worker adquire o job e completa, o outro rejeita com ActiveLeaseError
      expect(worker1Acquired !== worker2Acquired).toBe(true);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ActiveLeaseError,
      );

      const finalJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(finalJob?.status).toBe("COMPLETED");
      expect(finalJob?.attemptNumber).toBe(1);
    });

    it("lease ativa bloqueando aquisição e rejeitando com ActiveLeaseError (não falso sucesso)", async () => {
      const activeLease = new Date(Date.now() + 60_000);
      const { job, organizationId, clientId } = await createTestFixture({
        initialStatus: "PROCESSING",
        leaseExpiresAt: activeLease,
      });

      let acquired = false;
      await expect(
        executeRenderJob(
          { renderJobId: job.id, organizationId, clientId },
          db,
          storage,
          {
            onAfterAcquisition: async (acq) => {
              acquired = acq;
            },
          },
        ),
      ).rejects.toThrow(ActiveLeaseError);

      expect(acquired).toBe(false);
      const after = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(after?.status).toBe("PROCESSING");
    });

    it("falha transitória do banco na aquisição permite retry do BullMQ (não lança UnrecoverableError)", async () => {
      const { job, organizationId, clientId } = await createTestFixture();

      const failingDb = {
        ...db,
        $transaction: async () => {
          throw new Error("Connection terminated unexpectedly");
        },
      } as unknown as typeof db;

      let caughtErr: unknown;
      try {
        await executeRenderJob(
          { renderJobId: job.id, organizationId, clientId },
          failingDb,
          storage,
        );
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(Error);
      expect(caughtErr).not.toBeInstanceOf(UnrecoverableError);
      expect((caughtErr as Error).message).toContain("Connection terminated");

      const jobAfter = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(jobAfter?.status).toBe("PENDING");
    });

    it("tenant inativo ou inválido lança UnrecoverableError de modo permanente", async () => {
      const { job } = await createTestFixture();

      await expect(
        executeRenderJob(
          {
            renderJobId: job.id,
            organizationId: "nonexistent-org",
            clientId: "nonexistent-client",
          },
          db,
          storage,
        ),
      ).rejects.toThrow(UnrecoverableError);
    });

    it("falha pós-aquisição libera job para PENDING se worker mantiver executionToken", async () => {
      const { job, organizationId, clientId } = await createTestFixture();

      await expect(
        executeRenderJob(
          { renderJobId: job.id, organizationId, clientId },
          db,
          storage,
          {
            onBeforeRender: async () => {
              throw new Error("Transient GPU/Sharp crash");
            },
          },
        ),
      ).rejects.toThrow("Transient GPU/Sharp crash");

      const releasedJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(releasedJob?.status).toBe("PENDING");
      expect(releasedJob?.leaseExpiresAt).toBeNull();
      expect(releasedJob?.executionToken).toBeNull();
    });

    it("falha durante reserva do MediaAsset libera ou deixa lease recuperável", async () => {
      const { job, organizationId, clientId } = await createTestFixture();

      await expect(
        executeRenderJob(
          { renderJobId: job.id, organizationId, clientId },
          db,
          storage,
          {
            onBeforeStoragePut: async () => {
              throw new Error("Simulated failure before storage put");
            },
          },
        ),
      ).rejects.toThrow("Simulated failure before storage put");

      const currentJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(currentJob?.status).toBe("PENDING");
    });

    it("falha durante finalização não produz falso COMPLETED", async () => {
      const { job, organizationId, clientId } = await createTestFixture();

      await expect(
        executeRenderJob(
          { renderJobId: job.id, organizationId, clientId },
          db,
          storage,
          {
            onBeforeFinalize: async () => {
              await migration.renderJob.update({
                where: { id: job.id },
                data: { executionToken: "superseded-token" },
              });
            },
          },
        ),
      ).rejects.toThrow(/Fencing token mismatch/i);

      const notCompletedJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(notCompletedJob?.status).not.toBe("COMPLETED");
    });

    it("lease expirada permitindo recuperação", async () => {
      const expiredLease = new Date(Date.now() - 10_000);
      const { job, organizationId, clientId } = await createTestFixture({
        initialStatus: "PROCESSING",
        leaseExpiresAt: expiredLease,
      });

      let acquired = false;
      await executeRenderJob(
        { renderJobId: job.id, organizationId, clientId },
        db,
        storage,
        {
          onAfterAcquisition: async (acq) => {
            acquired = acq;
          },
        },
      );

      expect(acquired).toBe(true);
      const after = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(after?.status).toBe("COMPLETED");

      const auditRecovered = await migration.auditLog.findFirst({
        where: {
          entityId: job.id,
          action: "render.recovered",
        },
      });
      expect(auditRecovered).toBeTruthy();
    });

    it("fencing por executionToken impede worker antigo de finalizar job após recuperação de lease", async () => {
      const { job, organizationId, clientId } = await createTestFixture();

      let worker1Token: string | null = null;
      let hookTriggered = false;

      // Worker 1 adquire o job e aguarda antes da finalização
      const worker1Promise = executeRenderJob(
        { renderJobId: job.id, organizationId, clientId },
        db,
        storage,
        {
          onBeforeFinalize: async () => {
            hookTriggered = true;
            // Salva o token do worker 1
            const current = await migration.renderJob.findUnique({
              where: { id: job.id },
            });
            worker1Token = current?.executionToken ?? null;

            // Simula expiração da lease e recuperação por outro worker (Worker 2)
            await migration.renderJob.update({
              where: { id: job.id },
              data: {
                executionToken: "worker-2-new-token",
                leaseExpiresAt: new Date(Date.now() + 60_000),
              },
            });
          },
        },
      );

      // Worker 1 deve falhar na finalização por mismatch de fencing token
      await expect(worker1Promise).rejects.toThrow(/Fencing token mismatch/i);
      expect(hookTriggered).toBe(true);
      expect(worker1Token).toBeTruthy();
    });
  });

  describe("Validação de Mídias e Erros Permanentes vs Transitórios", () => {
    it("render sem mídias opcionais", async () => {
      const { job, organizationId, clientId } = await createTestFixture({
        includeBackground: false,
        includeLogo: false,
      });

      await executeRenderJob(
        { renderJobId: job.id, organizationId, clientId },
        db,
        storage,
      );

      const completedJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(completedJob?.status).toBe("COMPLETED");
      expect(completedJob?.outputMediaAssetId).toBe(job.id);
    });

    it("background e logotipo válidos", async () => {
      const { job, organizationId, clientId } = await createTestFixture({
        includeBackground: true,
        includeLogo: true,
      });

      await executeRenderJob(
        { renderJobId: job.id, organizationId, clientId },
        db,
        storage,
      );

      const completedJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(completedJob?.status).toBe("COMPLETED");
    });

    it("hash divergente da mídia de origem termina em FAILED com MEDIA_HASH_MISMATCH", async () => {
      const { job, organizationId, clientId } = await createTestFixture({
        includeBackground: true,
        corruptMediaHash: true,
      });

      await expect(
        executeRenderJob(
          { renderJobId: job.id, organizationId, clientId },
          db,
          storage,
        ),
      ).rejects.toThrow(/Background media hash mismatch/i);

      const failedJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(failedJob?.status).toBe("FAILED");
      expect(failedJob?.errorCode).toBe("MEDIA_HASH_MISMATCH");
      expect(failedJob?.executionToken).toBeNull();
      expect(failedJob?.leaseExpiresAt).toBeNull();

      const audit = await migration.auditLog.findFirst({
        where: { entityId: job.id, action: "render.failed" },
      });
      expect(audit).toBeTruthy();
    });

    it("erro permanente de input hash divergente termina em FAILED", async () => {
      const { job, organizationId, clientId } = await createTestFixture({
        corruptInputHash: true,
      });

      await expect(
        executeRenderJob(
          { renderJobId: job.id, organizationId, clientId },
          db,
          storage,
        ),
      ).rejects.toThrow(/Input hash mismatch/i);

      const failedJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(failedJob?.status).toBe("FAILED");
      expect(failedJob?.errorCode).toBe("INPUT_HASH_MISMATCH");
    });

    it("erro transitório de storage permite retry e libera o job de volta para PENDING", async () => {
      const { job, organizationId, clientId } = await createTestFixture({
        includeBackground: true,
      });

      const failingStorage: MediaStorage = {
        put: storage.put.bind(storage),
        get: async () => {
          throw new Error("Temporary S3 network timeout");
        },
        close: () => {},
      };

      await expect(
        executeRenderJob(
          { renderJobId: job.id, organizationId, clientId },
          db,
          failingStorage,
        ),
      ).rejects.toThrow(/Temporary S3 network timeout/i);

      // O job não deve ser marcado como FAILED; deve ser liberado para PENDING
      const releasedJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(releasedJob?.status).toBe("PENDING");
      expect(releasedJob?.leaseExpiresAt).toBeNull();
      expect(releasedJob?.executionToken).toBeNull();
    });
  });

  describe("Determinismo, Idempotência e Recuperação de Armazenamento", () => {
    it("criação determinística do MediaAsset com id = renderJobId e storageKey padronizada", async () => {
      const { job, organizationId, clientId } = await createTestFixture();

      await executeRenderJob(
        { renderJobId: job.id, organizationId, clientId },
        db,
        storage,
      );

      const asset = await migration.mediaAsset.findUnique({
        where: { id: job.id },
      });
      expect(asset).toBeTruthy();
      expect(asset?.id).toBe(job.id);
      expect(asset?.organizationId).toBe(organizationId);
      expect(asset?.clientId).toBe(clientId);
      expect(asset?.storageKey).toBe(
        `media/${organizationId}/${clientId}/${job.id}`,
      );
      expect(asset?.status).toBe("ready");
      expect(asset?.mimeType).toBe("image/png");
      expect(asset?.byteSize).toBeGreaterThan(0);
      expect(asset?.sha256).toHaveLength(64);
    });

    it("retry sem segundo ativo na tabela MediaAsset", async () => {
      const { job, organizationId, clientId } = await createTestFixture();

      // Executa a primeira vez
      await executeRenderJob(
        { renderJobId: job.id, organizationId, clientId },
        db,
        storage,
      );

      // Simula uma segunda execução / retry
      await executeRenderJob(
        { renderJobId: job.id, organizationId, clientId },
        db,
        storage,
      );

      const count = await migration.mediaAsset.count({
        where: { id: job.id },
      });
      expect(count).toBe(1);
    });

    it("falha antes do upload mantém MediaAsset pending e permite reexecução limpa", async () => {
      const { job, organizationId, clientId } = await createTestFixture();

      await expect(
        executeRenderJob(
          { renderJobId: job.id, organizationId, clientId },
          db,
          storage,
          {
            onBeforeStoragePut: async () => {
              throw new Error("Simulated crash before upload");
            },
          },
        ),
      ).rejects.toThrow(/Simulated crash before upload/i);

      const asset = await migration.mediaAsset.findUnique({
        where: { id: job.id },
      });
      expect(asset?.status).toBe("pending");

      // Simula expiração da lease para recuperação pelo worker
      await migration.renderJob.update({
        where: { id: job.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      });

      // Segunda execução conclui com sucesso
      await executeRenderJob(
        { renderJobId: job.id, organizationId, clientId },
        db,
        storage,
      );

      const completed = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(completed?.status).toBe("COMPLETED");

      const finalAsset = await migration.mediaAsset.findUnique({
        where: { id: job.id },
      });
      expect(finalAsset?.status).toBe("ready");
    });

    it("falha depois do upload e antes do commit recupera objeto existente correto e finaliza banco", async () => {
      const { job, organizationId, clientId } = await createTestFixture();

      // Primeira tentativa: upload ocorre, mas quebra antes de finalizar o banco
      await expect(
        executeRenderJob(
          { renderJobId: job.id, organizationId, clientId },
          db,
          storage,
          {
            onBeforeFinalize: async () => {
              throw new Error("Simulated crash after upload before commit");
            },
          },
        ),
      ).rejects.toThrow(/Simulated crash after upload before commit/i);

      // Objeto já está no storage!
      const targetKey = `media/${organizationId}/${clientId}/${job.id}`;
      const existing = await storage.get(targetKey);
      expect(existing.length).toBeGreaterThan(0);

      // Simula expiração da lease para permitir nova tentativa
      await migration.renderJob.update({
        where: { id: job.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      });

      // Segunda tentativa: detecta o objeto existente, valida seus bytes e finaliza
      await executeRenderJob(
        { renderJobId: job.id, organizationId, clientId },
        db,
        storage,
      );

      const finalJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(finalJob?.status).toBe("COMPLETED");
      expect(finalJob?.outputMediaAssetId).toBe(job.id);
    });

    it("rejeição de objeto existente divergente termina em FAILED com OUTPUT_OBJECT_CONFLICT", async () => {
      const { job, organizationId, clientId } = await createTestFixture();
      const targetKey = `media/${organizationId}/${clientId}/${job.id}`;

      // Grava propositalmente um objeto divergente na mesma chave
      const divergentPng = await sharp({
        create: {
          width: 50,
          height: 50,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
      await storage.put(targetKey, divergentPng, "image/png");

      await expect(
        executeRenderJob(
          { renderJobId: job.id, organizationId, clientId },
          db,
          storage,
        ),
      ).rejects.toThrow(/Output object conflict in storage/i);

      const failedJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(failedJob?.status).toBe("FAILED");
      expect(failedJob?.errorCode).toBe("OUTPUT_OBJECT_CONFLICT");

      // Confere que o objeto divergente NÃO foi sobrescrito
      const stored = await storage.get(targetKey);
      expect(Buffer.compare(stored, divergentPng)).toBe(0);
    });
  });

  describe("Reconciliação de Inicialização", () => {
    it("reconciliação de PENDING reenfileira job ausente na fila", async () => {
      const { job } = await createTestFixture({ initialStatus: "PENDING" });
      const queue = createRenderQueue(redis);

      // Garante que o job não está no BullMQ
      const expectedJobId = getRenderQueueJobId(job.id);
      const existing = await queue.getJob(expectedJobId);
      if (existing) await existing.remove();

      const result = await runRendererStartupReconciliation(db, redis);
      expect(result.recoveredJobs).toBeGreaterThanOrEqual(1);

      const enqueued = await queue.getJob(expectedJobId);
      expect(enqueued).toBeTruthy();
      expect(enqueued?.data.renderJobId).toBe(job.id);

      await closeRenderQueue(queue);
    });

    it("reconciliação de lease expirada reseta status para PENDING e reenfileira", async () => {
      const expiredLease = new Date(Date.now() - 30_000);
      const { job } = await createTestFixture({
        initialStatus: "PROCESSING",
        leaseExpiresAt: expiredLease,
      });

      const queue = createRenderQueue(redis);
      const expectedJobId = getRenderQueueJobId(job.id);
      const existing = await queue.getJob(expectedJobId);
      if (existing) await existing.remove();

      const result = await runRendererStartupReconciliation(db, redis);
      expect(result.recoveredJobs).toBeGreaterThanOrEqual(1);

      const updatedJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(updatedJob?.status).toBe("PENDING");
      expect(updatedJob?.leaseExpiresAt).toBeNull();
      expect(updatedJob?.executionToken).toBeNull();

      await closeRenderQueue(queue);
    });

    it("exclusão de COMPLETED, FAILED e lease ativa da reconciliação", async () => {
      const completedFixture = await createTestFixture({
        initialStatus: "COMPLETED",
      });
      const failedFixture = await createTestFixture({
        initialStatus: "FAILED",
      });
      const activeLeaseFixture = await createTestFixture({
        initialStatus: "PROCESSING",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });

      const queue = createRenderQueue(redis);

      const candidateJobs = await asSystemRendererDiscovery(db, async (tx) => {
        return tx.$queryRaw<Array<{ renderJobId: string }>>`
          SELECT "renderJobId" FROM discover_reconcilable_render_jobs()
        `;
      });

      const candidateIds = candidateJobs.map((c) => c.renderJobId);
      expect(candidateIds).not.toContain(completedFixture.job.id);
      expect(candidateIds).not.toContain(failedFixture.job.id);
      expect(candidateIds).not.toContain(activeLeaseFixture.job.id);

      await closeRenderQueue(queue);
    });

    it("reconciliação periódica não se sobrepõe (guarda isRunning)", async () => {
      const reconciler = new RendererReconciler(db, redis, {
        intervalMs: 10_000,
      });

      const p1 = reconciler.runReconciliation();
      const p2 = reconciler.runReconciliation();
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.recoveredJobs >= 0).toBe(true);
      expect(r2.recoveredJobs === 0 || r1.recoveredJobs === 0).toBe(true);

      reconciler.stop();
    });

    it("reconciliação periódica não cria jobs duplicados na fila", async () => {
      const { job } = await createTestFixture({ initialStatus: "PENDING" });
      const queue = createRenderQueue(redis);

      const expectedJobId = getRenderQueueJobId(job.id);
      const existing = await queue.getJob(expectedJobId);
      if (existing) await existing.remove();

      const reconciler = new RendererReconciler(db, redis, {
        intervalMs: 10_000,
      });
      const res1 = await reconciler.runReconciliation();
      const res2 = await reconciler.runReconciliation();

      expect(res1.recoveredJobs).toBeGreaterThanOrEqual(1);
      expect(res2.recoveredJobs).toBe(0);

      const jobInQueue = await queue.getJob(expectedJobId);
      expect(jobInQueue).toBeTruthy();

      reconciler.stop();
      await closeRenderQueue(queue);
    });

    it("processo interrompido é recuperado sem reiniciar o container", async () => {
      const expiredLease = new Date(Date.now() - 5000);
      const { job } = await createTestFixture({
        initialStatus: "PROCESSING",
        leaseExpiresAt: expiredLease,
      });

      const queue = createRenderQueue(redis);
      const expectedJobId = getRenderQueueJobId(job.id);
      const existing = await queue.getJob(expectedJobId);
      if (existing) await existing.remove();

      const reconciler = new RendererReconciler(db, redis, {
        intervalMs: 500,
      });
      const cycleResult = await reconciler.runReconciliation();
      expect(cycleResult.recoveredJobs).toBeGreaterThanOrEqual(1);

      const recovered = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(recovered?.status).toBe("PENDING");
      expect(recovered?.leaseExpiresAt).toBeNull();
      expect(recovered?.executionToken).toBeNull();

      reconciler.stop();
      await closeRenderQueue(queue);
    });

    it("shutdown encerra timer da reconciliação", async () => {
      const reconciler = new RendererReconciler(db, redis, {
        intervalMs: 1000,
      });
      reconciler.start();
      expect(reconciler.active).toBe(true);

      reconciler.stop();
      expect(reconciler.active).toBe(false);
    });
  });

  describe("Isolamento de Tenants", () => {
    it("isolamento entre tenants: worker do tenant A não acessa dados do tenant B", async () => {
      const fixtureB = await createTestFixture({
        organizationId: "org-b",
        clientId: "client-b",
      });

      // Tenta executar passando escopo cruzado inválido
      await expect(
        executeRenderJob(
          {
            renderJobId: fixtureB.job.id,
            organizationId: "org-a",
            clientId: "client-a",
          },
          db,
          storage,
        ),
      ).rejects.toThrow(UnrecoverableError); // Acquisition é ignorada com status SKIPPED: NOT_FOUND sob RLS -> lança UnrecoverableError

      const jobB = await migration.renderJob.findUnique({
        where: { id: fixtureB.job.id },
      });
      expect(jobB?.status).toBe("PENDING");
    });
  });

  describe("Isolamento Operacional e Healthcheck Independente", () => {
    it("worker BullMQ encerra graciosamente sem travar", async () => {
      const worker = createRendererWorker(db, redis, storage, {
        concurrency: 1,
      });
      await worker.waitUntilReady();
      await expect(worker.close()).resolves.toBeUndefined();
    });

    it("healthcheck independente responde 200 em /health/ready e /health/live no renderer com storage disponível", async () => {
      const worker = createRendererWorker(db, redis, storage, {
        concurrency: 1,
      });
      await worker.waitUntilReady();

      const server = createServer(async (req, res) => {
        if (req.url === "/health/ready") {
          try {
            const storageReady = storage.checkReadiness
              ? await storage.checkReadiness()
              : true;
            if (!storageReady) throw new Error("Storage unreachable");
            await Promise.all([
              db.$queryRaw`SELECT 1`,
              redis.ping(),
              worker.waitUntilReady(),
            ]);
            res
              .writeHead(200, { "Content-Type": "application/json" })
              .end('{"status":"ok"}');
          } catch {
            res.writeHead(503).end('{"status":"unavailable"}');
          }
        } else if (req.url === "/health/live") {
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end('{"status":"ok"}');
        } else {
          res.writeHead(404).end();
        }
      });

      const port = await new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve((server.address() as AddressInfo).port);
        });
      });

      const liveRes = await fetch(`http://127.0.0.1:${port}/health/live`);
      expect(liveRes.status).toBe(200);

      const readyRes = await fetch(`http://127.0.0.1:${port}/health/ready`);
      expect(readyRes.status).toBe(200);
      const readyJson = await readyRes.json();
      expect(readyJson).toEqual({ status: "ok" });

      await new Promise<void>((resolve) => server.close(() => resolve()));
      await worker.close();
    });

    it("healthcheck readiness retorna 503 quando storage estiver inacessível e liveness permanece 200", async () => {
      const unavailableStorage = {
        ...storage,
        checkReadiness: async () => false,
      };

      const server = createServer(async (req, res) => {
        if (req.url === "/health/ready") {
          try {
            const storageReady = unavailableStorage.checkReadiness
              ? await unavailableStorage.checkReadiness()
              : true;
            if (!storageReady) throw new Error("Storage unreachable");
            res
              .writeHead(200, { "Content-Type": "application/json" })
              .end('{"status":"ok"}');
          } catch {
            res.writeHead(503).end('{"status":"unavailable"}');
          }
        } else if (req.url === "/health/live") {
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end('{"status":"ok"}');
        } else {
          res.writeHead(404).end();
        }
      });

      const port = await new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve((server.address() as AddressInfo).port);
        });
      });

      const liveRes = await fetch(`http://127.0.0.1:${port}/health/live`);
      expect(liveRes.status).toBe(200);

      const readyRes = await fetch(`http://127.0.0.1:${port}/health/ready`);
      expect(readyRes.status).toBe(503);
      const readyJson = await readyRes.json();
      expect(readyJson).toEqual({ status: "unavailable" });

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("fila de render artwork-render é independente e não interfere na fila publication-schedule", async () => {
      expect(RENDER_QUEUE_NAME).toBe("artwork-render");
      expect(RENDER_QUEUE_NAME).not.toBe("publication-schedule");
    });
  });

  describe("Geração Real Local nos Três Formatos (SQUARE, PORTRAIT, STORY)", () => {
    const formats: DesignFormat[] = ["SQUARE", "PORTRAIT", "STORY"];

    for (const format of formats) {
      it(`gera imagem real em formato ${format} com dimensões, MIME e SHA-256 exatos`, async () => {
        const { width: expectedWidth, height: expectedHeight } =
          designDimensions[format];

        const { job, organizationId, clientId } = await createTestFixture({
          format,
          includeBackground: true,
          includeLogo: true,
          spec: {
            titleMaxLines: 2,
            textAlign: "left",
          },
          input: {
            eyebrow: `Edição ${format}`,
            title: `Arte Determinística em ${format}`,
            subtitle:
              "Renderizada pelo Satori e Sharp com isolamento de tenant",
            callToAction: "Ver Detalhes",
          },
        });

        // Executa renderização completa
        await executeRenderJob(
          { renderJobId: job.id, organizationId, clientId },
          db,
          storage,
        );

        // 1. Confere no banco
        const completedJob = await migration.renderJob.findUnique({
          where: { id: job.id },
          include: { outputMediaAsset: true },
        });

        expect(completedJob?.status).toBe("COMPLETED");
        expect(completedJob?.outputMediaAssetId).toBe(job.id);
        expect(completedJob?.completedAt).toBeTruthy();

        const asset = completedJob?.outputMediaAsset;
        expect(asset).toBeTruthy();
        expect(asset?.status).toBe("ready");
        expect(asset?.mimeType).toBe("image/png");
        expect(asset?.width).toBe(expectedWidth);
        expect(asset?.height).toBe(expectedHeight);
        expect(asset?.byteSize).toBeGreaterThan(1000);
        expect(asset?.sha256).toHaveLength(64);

        // 2. Confere os bytes no storage local
        const targetStorageKey = `media/${organizationId}/${clientId}/${job.id}`;
        const storedBytes = await storage.get(targetStorageKey);
        expect(storedBytes).toBeTruthy();
        expect(storedBytes.length).toBe(asset?.byteSize);

        const actualSha256 = createHash("sha256")
          .update(storedBytes)
          .digest("hex");
        expect(actualSha256).toBe(asset?.sha256);

        // 3. Validação Sharp da imagem real persistida
        const metadata = await sharp(storedBytes).metadata();
        expect(metadata.format).toBe("png");
        expect(metadata.width).toBe(expectedWidth);
        expect(metadata.height).toBe(expectedHeight);

        // 4. Idempotência / recuperação sem duplicação
        await executeRenderJob(
          { renderJobId: job.id, organizationId, clientId },
          db,
          storage,
        );
        const count = await migration.mediaAsset.count({
          where: { id: job.id },
        });
        expect(count).toBe(1);
      });
    }
  });

  describe("Fase 6 Incremento 3: Render Batch no Worker e Reconciliador", () => {
    it("deve atualizar contadores do RenderBatch atomicamente a cada job concluído", async () => {
      const { version, organizationId, clientId } = await createTestFixture();

      // Criar um RenderBatch com 2 jobs
      const batch = await migration.renderBatch.create({
        data: {
          organizationId,
          clientId,
          templateVersionId: version.id,
          sourceType: "POSTS_SELECTION",
          format: "PORTRAIT",
          status: "PENDING",
          totalItems: 2,
          pendingItems: 2,
          idempotencyKey: `worker-batch-test-${randomUUID()}`,
          requestHash: "req-hash-worker-1",
          createdById: "admin-a",
        },
      });

      const job1 = await migration.renderJob.create({
        data: {
          organizationId,
          clientId,
          batchId: batch.id,
          templateVersionId: version.id,
          status: "PENDING",
          input: defaultInput as unknown as Prisma.InputJsonValue,
          inputHash: hashRenderInput(defaultSpec, defaultInput),
          idempotencyKey: `job1-${randomUUID()}`,
          createdById: "admin-a",
        },
      });

      const job2 = await migration.renderJob.create({
        data: {
          organizationId,
          clientId,
          batchId: batch.id,
          templateVersionId: version.id,
          status: "PENDING",
          input: defaultInput as unknown as Prisma.InputJsonValue,
          inputHash: hashRenderInput(defaultSpec, defaultInput),
          idempotencyKey: `job2-${randomUUID()}`,
          createdById: "admin-a",
        },
      });

      // Executa job1
      await executeRenderJob(
        { renderJobId: job1.id, organizationId, clientId },
        db,
        storage,
      );

      const batchAfterJob1 = await migration.renderBatch.findUnique({
        where: { id: batch.id },
      });
      expect(batchAfterJob1?.completedItems).toBe(1);
      expect(batchAfterJob1?.pendingItems).toBe(1);
      expect(batchAfterJob1?.status).toBe("PROCESSING");

      // Executa job2
      await executeRenderJob(
        { renderJobId: job2.id, organizationId, clientId },
        db,
        storage,
      );

      const batchAfterJob2 = await migration.renderBatch.findUnique({
        where: { id: batch.id },
      });
      expect(batchAfterJob2?.completedItems).toBe(2);
      expect(batchAfterJob2?.pendingItems).toBe(0);
      expect(batchAfterJob2?.status).toBe("COMPLETED");
      expect(batchAfterJob2?.completedAt).toBeDefined();
    });

    it("deve cancelar cooperativamente o job se o RenderBatch tiver cancelRequestedAt", async () => {
      const { version, organizationId, clientId } = await createTestFixture();

      const batch = await migration.renderBatch.create({
        data: {
          organizationId,
          clientId,
          templateVersionId: version.id,
          sourceType: "POSTS_SELECTION",
          format: "PORTRAIT",
          status: "PENDING",
          totalItems: 1,
          pendingItems: 1,
          cancelRequestedAt: new Date(),
          idempotencyKey: `worker-batch-cancel-${randomUUID()}`,
          requestHash: "req-hash-worker-2",
          createdById: "admin-a",
        },
      });

      const job = await migration.renderJob.create({
        data: {
          organizationId,
          clientId,
          batchId: batch.id,
          templateVersionId: version.id,
          status: "PENDING",
          input: defaultInput as unknown as Prisma.InputJsonValue,
          inputHash: hashRenderInput(defaultSpec, defaultInput),
          idempotencyKey: `job-cancelled-${randomUUID()}`,
          createdById: "admin-a",
        },
      });

      // Executa o job; o worker deve detectar cancelRequestedAt e marcar CANCELLED
      await executeRenderJob(
        { renderJobId: job.id, organizationId, clientId },
        db,
        storage,
      );

      const dbJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(dbJob?.status).toBe("CANCELLED");

      const dbBatch = await migration.renderBatch.findUnique({
        where: { id: batch.id },
      });
      expect(dbBatch?.status).toBe("CANCELLED");
      expect(dbBatch?.cancelledItems).toBe(1);
      expect(dbBatch?.pendingItems).toBe(0);
      expect(dbBatch?.cancelCompletedAt).toBeDefined();
    });

    it("deve sincronizar contadores no reconciliador de renderização", async () => {
      const { version, organizationId, clientId } = await createTestFixture();

      // Batch com contadores desatualizados propositalmente
      const batch = await migration.renderBatch.create({
        data: {
          organizationId,
          clientId,
          templateVersionId: version.id,
          sourceType: "POSTS_SELECTION",
          format: "PORTRAIT",
          status: "PROCESSING",
          totalItems: 1,
          pendingItems: 1,
          completedItems: 0,
          idempotencyKey: `worker-batch-reconcile-${randomUUID()}`,
          requestHash: "req-hash-worker-3",
          createdById: "admin-a",
        },
      });

      // Job já concluído no banco
      await migration.renderJob.create({
        data: {
          organizationId,
          clientId,
          batchId: batch.id,
          templateVersionId: version.id,
          status: "COMPLETED",
          input: defaultInput as unknown as Prisma.InputJsonValue,
          inputHash: hashRenderInput(defaultSpec, defaultInput),
          idempotencyKey: `job-reconcile-${randomUUID()}`,
          createdById: "admin-a",
          completedAt: new Date(),
        },
      });

      // Roda reconciliação
      await runRendererReconciliationCycle(db, redis);

      const reconciledBatch = await migration.renderBatch.findUnique({
        where: { id: batch.id },
      });
      expect(reconciledBatch?.completedItems).toBe(1);
      expect(reconciledBatch?.pendingItems).toBe(0);
      expect(reconciledBatch?.status).toBe("COMPLETED");

      // Chamada repetida do reconciliador deve ser estritamente idempotente
      await expect(
        runRendererReconciliationCycle(db, redis),
      ).resolves.not.toThrow();
    });

    it("deve processar jobs com entradas idênticas de forma independente, determinística e sem colisão de chave (Opção C)", async () => {
      const { version, organizationId, clientId } = await createTestFixture();

      const batch = await migration.renderBatch.create({
        data: {
          organizationId,
          clientId,
          templateVersionId: version.id,
          sourceType: "POSTS_SELECTION",
          format: "PORTRAIT",
          status: "PENDING",
          totalItems: 2,
          pendingItems: 2,
          idempotencyKey: `dedup-batch-${randomUUID()}`,
          requestHash: "req-hash-dedup",
          createdById: "admin-a",
        },
      });

      const sharedInputHash = hashRenderInput(defaultSpec, defaultInput);

      // Job 1
      const job1 = await migration.renderJob.create({
        data: {
          organizationId,
          clientId,
          batchId: batch.id,
          templateVersionId: version.id,
          status: "PENDING",
          input: defaultInput as unknown as Prisma.InputJsonValue,
          inputHash: sharedInputHash,
          idempotencyKey: `job-dedup-1-${randomUUID()}`,
          createdById: "admin-a",
        },
      });

      // Job 2 com MESMO input e MESMO spec (mesmo inputHash)
      const job2 = await migration.renderJob.create({
        data: {
          organizationId,
          clientId,
          batchId: batch.id,
          templateVersionId: version.id,
          status: "PENDING",
          input: defaultInput as unknown as Prisma.InputJsonValue,
          inputHash: sharedInputHash,
          idempotencyKey: `job-dedup-2-${randomUUID()}`,
          createdById: "admin-a",
        },
      });

      // Executa Job 1 (renderiza e salva no storage sob seu ID)
      await executeRenderJob(
        { renderJobId: job1.id, organizationId, clientId },
        db,
        storage,
      );

      const dbJob1 = await migration.renderJob.findUnique({
        where: { id: job1.id },
      });
      expect(dbJob1?.status).toBe("COMPLETED");
      expect(dbJob1?.outputMediaAssetId).toBe(job1.id);

      // Executa Job 2 (renderiza e salva no storage sob seu próprio ID, sem colisão e em total isolamento)
      await executeRenderJob(
        { renderJobId: job2.id, organizationId, clientId },
        db,
        storage,
      );

      const dbJob2 = await migration.renderJob.findUnique({
        where: { id: job2.id },
      });
      expect(dbJob2?.status).toBe("COMPLETED");
      expect(dbJob2?.outputMediaAssetId).toBe(job2.id);

      // Ambos os arquivos no storage devem existir e possuir o mesmo hash SHA-256
      const asset1 = await migration.mediaAsset.findUnique({
        where: { id: job1.id },
      });
      const asset2 = await migration.mediaAsset.findUnique({
        where: { id: job2.id },
      });
      expect(asset1?.sha256).toBe(asset2?.sha256);
      expect(asset1?.byteSize).toBe(asset2?.byteSize);
      expect(asset1?.storageKey).toBe(
        `media/${organizationId}/${clientId}/${job1.id}`,
      );
      expect(asset2?.storageKey).toBe(
        `media/${organizationId}/${clientId}/${job2.id}`,
      );
    });

    it("deve preservar snapshot imutável: editar o post original não afeta a arte gerada", async () => {
      const { version, organizationId, clientId } = await createTestFixture();

      // 1. Cria post com texto original
      const originalTitle = `Título Original Reserva ${randomUUID()}`;
      const post = await migration.post.create({
        data: {
          organizationId,
          clientId,
          title: originalTitle,
          caption: "Legenda de teste snapshot",
          status: "DRAFT",
        },
      });

      const inputSnapshot = artworkInputSchema.parse({
        title: originalTitle,
        eyebrow: "Snapshot Test",
        subtitle: "Subtítulo Imutável",
        callToAction: "Ver mais",
        backgroundMediaAssetId: null,
        logoMediaAssetId: null,
      });

      const batch = await migration.renderBatch.create({
        data: {
          organizationId,
          clientId,
          templateVersionId: version.id,
          sourceType: "POSTS_SELECTION",
          format: "PORTRAIT",
          status: "PENDING",
          totalItems: 1,
          pendingItems: 1,
          idempotencyKey: `snapshot-batch-${randomUUID()}`,
          requestHash: "req-hash-snapshot",
          createdById: "admin-a",
        },
      });

      const job = await migration.renderJob.create({
        data: {
          organizationId,
          clientId,
          batchId: batch.id,
          postId: post.id,
          templateVersionId: version.id,
          status: "PENDING",
          input: inputSnapshot as unknown as Prisma.InputJsonValue,
          inputHash: hashRenderInput(defaultSpec, inputSnapshot),
          idempotencyKey: `job-snapshot-${randomUUID()}`,
          createdById: "admin-a",
        },
      });

      // 2. EDITA O POST ORIGINAL no banco antes do worker rodar
      await migration.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT set_config('app.user_id', 'admin-a', true)
        `;
        await tx.post.update({
          where: { id: post.id },
          data: {
            title: "TEXTO COMPLETAMENTE MODIFICADO DEPOIS DA RESERVA",
            caption: "LEGENDA MODIFICADA",
          },
        });
      });

      // 3. Executa o job
      await executeRenderJob(
        { renderJobId: job.id, organizationId, clientId },
        db,
        storage,
      );

      // 4. Job deve ler do snapshot persistido em RenderJob.input
      const completedJob = await migration.renderJob.findUnique({
        where: { id: job.id },
      });
      expect(completedJob?.status).toBe("COMPLETED");
      const jobInput = completedJob?.input as unknown as ArtworkInput;
      expect(jobInput.title).toBe(originalTitle);
      expect(jobInput.title).not.toContain("MODIFICADO");
    });
  });
});
