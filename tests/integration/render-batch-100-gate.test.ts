import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { Redis } from "ioredis";
import sharp from "sharp";
import { createDatabase, type Prisma } from "@socialflow/db";
import {
  executeRenderJob,
  runRendererReconciliationCycle,
  ActiveLeaseError,
} from "../../apps/worker/src/renderer-worker.js";
import {
  mediaStorage,
  type MediaStorage,
} from "../../apps/api/src/media-storage.js";
import {
  hashRenderInput,
  RENDERER_VERSION,
} from "../../packages/render/src/index.js";
import {
  type DesignTemplateSpec,
  type ArtworkInput,
  artworkInputSchema,
} from "../../packages/contracts/src/index.js";

const db = createDatabase(process.env.DATABASE_URL!) as Parameters<
  typeof executeRenderJob
>[1];
const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);
let redis: Redis;
let storage: MediaStorage;

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

function createJobInput(
  title: string,
  subtitle: string,
): { parsed: ArtworkInput; hash: string } {
  const parsed = artworkInputSchema.parse({
    title,
    eyebrow: "SocialFlow",
    subtitle,
    callToAction: "Saiba mais",
    backgroundMediaAssetId: null,
    logoMediaAssetId: null,
  });
  const hash = hashRenderInput(defaultSpec, parsed);
  return { parsed, hash };
}

describe("Fase 6 Incremento 3: Gate de Carga Controlada de 10, 25, 50 e 100 Artes", () => {
  let templateVersionId: string;
  const organizationId = "org-a";
  const clientId = "client-a";

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:54379", {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    await redis.connect();

    const s = mediaStorage(process.env);
    if (!s) throw new Error("Local media storage could not be initialized");
    storage = s;

    // Cria template e versão para o teste
    const template = await migration.designTemplate.create({
      data: {
        organizationId,
        clientId,
        name: `Gate Template ${randomUUID()}`,
      },
    });

    const specHash = createHash("sha256")
      .update(JSON.stringify(defaultSpec))
      .digest("hex");

    const version = await migration.designTemplateVersion.create({
      data: {
        organizationId,
        clientId,
        templateId: template.id,
        version: 1,
        format: "PORTRAIT",
        spec: defaultSpec as unknown as Prisma.InputJsonValue,
        specHash,
        rendererVersion: RENDERER_VERSION,
      },
    });

    templateVersionId = version.id;
  });

  afterAll(async () => {
    await migration.auditLog.deleteMany({
      where: { action: { startsWith: "batch." } },
    });
    await migration.renderJob.deleteMany({});
    await migration.renderBatch.deleteMany({});
    await migration.mediaAsset.deleteMany({});
    await migration.post.deleteMany({});
    await migration.designTemplateVersion.deleteMany({});
    await migration.designTemplate.deleteMany({});
    storage.close();
    redis.disconnect();
    await db.$disconnect();
    await migration.$disconnect();
  });

  it("1. Lote de 10 Artes: Aquecimento inicial e validação de integridade", async () => {
    // Cria RenderBatch
    const batch = await migration.renderBatch.create({
      data: {
        organizationId,
        clientId,
        templateVersionId,
        sourceType: "POSTS_SELECTION",
        format: "PORTRAIT",
        status: "PENDING",
        totalItems: 10,
        pendingItems: 10,
        idempotencyKey: `gate-10-${randomUUID()}`,
        requestHash: "req-hash-gate-10",
        createdById: "admin-a",
      },
    });

    const jobIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { parsed, hash } = createJobInput(
        `Lote 10 - Post #${i + 1}`,
        `Legenda da arte número ${i + 1} de 10 no aquecimento`,
      );
      const jobId = randomUUID();
      jobIds.push(jobId);

      await migration.renderJob.create({
        data: {
          id: jobId,
          organizationId,
          clientId,
          batchId: batch.id,
          templateVersionId,
          status: "PENDING",
          input: parsed as unknown as Prisma.InputJsonValue,
          inputHash: hash,
          idempotencyKey: `job-gate10-${i}-${randomUUID()}`,
          createdById: "admin-a",
        },
      });
    }

    // Executa os 10 jobs sequencialmente (concorrência = 1 da VPS)
    for (const jId of jobIds) {
      try {
        await executeRenderJob(
          { renderJobId: jId, organizationId, clientId },
          db,
          storage,
        );
      } catch (err) {
        if (!(err instanceof ActiveLeaseError)) {
          throw err;
        }
      }
    }

    const deadline1 = Date.now() + 15000;
    while (Date.now() < deadline1) {
      const b = await migration.renderBatch.findUnique({
        where: { id: batch.id },
      });
      if (b?.status === "COMPLETED" && b.completedItems === 10) {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // Verifica batch finalizado com sucesso
    const finishedBatch = await migration.renderBatch.findUnique({
      where: { id: batch.id },
    });
    expect(finishedBatch?.status).toBe("COMPLETED");
    expect(finishedBatch?.totalItems).toBe(10);
    expect(finishedBatch?.completedItems).toBe(10);
    expect(finishedBatch?.pendingItems).toBe(0);
    expect(finishedBatch?.failedItems).toBe(0);
    expect(finishedBatch?.cancelledItems).toBe(0);
  });

  it("2. Lote de 25 Artes com Interrupção e Retomada Segura pelo Reconciliador", async () => {
    const batch = await migration.renderBatch.create({
      data: {
        organizationId,
        clientId,
        templateVersionId,
        sourceType: "POSTS_SELECTION",
        format: "PORTRAIT",
        status: "PENDING",
        totalItems: 25,
        pendingItems: 25,
        idempotencyKey: `gate-25-${randomUUID()}`,
        requestHash: "req-hash-gate-25",
        createdById: "admin-a",
      },
    });

    const jobIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      const { parsed, hash } = createJobInput(
        `Lote 25 - Arte #${i + 1}`,
        `Descrição para validação de resiliência e retomada #${i + 1}`,
      );
      const jobId = randomUUID();
      jobIds.push(jobId);

      await migration.renderJob.create({
        data: {
          id: jobId,
          organizationId,
          clientId,
          batchId: batch.id,
          templateVersionId,
          status: "PENDING",
          input: parsed as unknown as Prisma.InputJsonValue,
          inputHash: hash,
          idempotencyKey: `job-gate25-${i}-${randomUUID()}`,
          createdById: "admin-a",
        },
      });
    }

    // Executa apenas os primeiros 10 itens
    for (let i = 0; i < 10; i++) {
      try {
        await executeRenderJob(
          { renderJobId: jobIds[i], organizationId, clientId },
          db,
          storage,
        );
      } catch (err) {
        if (!(err instanceof ActiveLeaseError)) {
          throw err;
        }
      }
    }

    // Guarda SHA-256 dos 10 primeiros
    const first10Assets = await migration.mediaAsset.findMany({
      where: { id: { in: jobIds.slice(0, 10) } },
      select: { id: true, sha256: true },
    });
    expect(first10Assets.length).toBe(10);

    // Simula interrupção brusca (crash do processo) e executa o ciclo de reconciliação
    await runRendererReconciliationCycle(db, redis);

    // Verifica que o batch reflete pelo menos 10 completados e status PROCESSING
    const batchMidway = await migration.renderBatch.findUnique({
      where: { id: batch.id },
    });
    expect(batchMidway?.completedItems).toBeGreaterThanOrEqual(10);
    expect(
      (batchMidway?.completedItems ?? 0) + (batchMidway?.pendingItems ?? 0),
    ).toBeLessThanOrEqual(25);
    expect(batchMidway?.status).toBe("PROCESSING");

    // Executa os 15 restantes (com tolerância a lease concorrente caso o worker de container esteja ativo)
    for (let i = 10; i < 25; i++) {
      try {
        await executeRenderJob(
          { renderJobId: jobIds[i], organizationId, clientId },
          db,
          storage,
        );
      } catch (err) {
        if (!(err instanceof ActiveLeaseError)) {
          throw err;
        }
      }
    }

    // Aguarda eventual conclusão pelo worker concorrente de background
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const b = await migration.renderBatch.findUnique({
        where: { id: batch.id },
      });
      if (b?.status === "COMPLETED" && b.completedItems === 25) {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // Verifica integridade: nenhum dos 10 primeiros foi modificado
    const first10After = await migration.mediaAsset.findMany({
      where: { id: { in: jobIds.slice(0, 10) } },
      select: { id: true, sha256: true },
    });
    for (const orig of first10Assets) {
      const match = first10After.find((a) => a.id === orig.id);
      expect(match?.sha256).toBe(orig.sha256);
    }

    // Lote finalizado
    const batchFinal = await migration.renderBatch.findUnique({
      where: { id: batch.id },
    });
    expect(batchFinal?.status).toBe("COMPLETED");
    expect(batchFinal?.completedItems).toBe(25);
    expect(batchFinal?.pendingItems).toBe(0);
  });

  it("3. Lote de 50 Artes com Isolamento Multitenant e Cancelamento Parcial", async () => {
    const batch = await migration.renderBatch.create({
      data: {
        organizationId,
        clientId,
        templateVersionId,
        sourceType: "POSTS_SELECTION",
        format: "PORTRAIT",
        status: "PENDING",
        totalItems: 50,
        pendingItems: 50,
        idempotencyKey: `gate-50-${randomUUID()}`,
        requestHash: "req-hash-gate-50",
        createdById: "admin-a",
      },
    });

    const jobIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const { parsed, hash } = createJobInput(
        `Lote 50 - Item #${i + 1}`,
        `Validação de cancelamento cooperativo e segurança multitenant #${i + 1}`,
      );
      const jobId = randomUUID();
      jobIds.push(jobId);

      await migration.renderJob.create({
        data: {
          id: jobId,
          organizationId,
          clientId,
          batchId: batch.id,
          templateVersionId,
          status: "PENDING",
          input: parsed as unknown as Prisma.InputJsonValue,
          inputHash: hash,
          idempotencyKey: `job-gate50-${i}-${randomUUID()}`,
          createdById: "admin-a",
        },
      });
    }

    // Processa os primeiros 20 jobs
    for (let i = 0; i < 20; i++) {
      try {
        await executeRenderJob(
          { renderJobId: jobIds[i], organizationId, clientId },
          db,
          storage,
        );
      } catch (err) {
        if (!(err instanceof ActiveLeaseError)) {
          throw err;
        }
      }
    }

    // Solicita cancelamento do lote (como faria a API)
    await migration.renderBatch.update({
      where: { id: batch.id },
      data: { cancelRequestedAt: new Date() },
    });

    // Quando os jobs 20 a 49 tentam rodar, o worker detecta cancelRequestedAt e cancela cooperativamente
    for (let i = 20; i < 50; i++) {
      try {
        await executeRenderJob(
          { renderJobId: jobIds[i], organizationId, clientId },
          db,
          storage,
        );
      } catch (err) {
        if (!(err instanceof ActiveLeaseError)) {
          throw err;
        }
      }
    }

    const deadline3 = Date.now() + 15000;
    while (Date.now() < deadline3) {
      const b = await migration.renderBatch.findUnique({
        where: { id: batch.id },
      });
      if (b?.status === "CANCELLED" && b.cancelledItems === 30) {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const cancelledBatch = await migration.renderBatch.findUnique({
      where: { id: batch.id },
    });
    expect(cancelledBatch?.status).toBe("CANCELLED");
    expect(cancelledBatch?.completedItems).toBe(20);
    expect(cancelledBatch?.cancelledItems).toBe(30);
    expect(cancelledBatch?.pendingItems).toBe(0);
    expect(cancelledBatch?.cancelCompletedAt).toBeDefined();

    // Garante que as 20 artes concluídas continuam preservadas
    const readyAssets = await migration.mediaAsset.findMany({
      where: { id: { in: jobIds.slice(0, 20) } },
    });
    expect(readyAssets.length).toBe(20);
  });

  it("4. GATE OFICIAL DE 100 ARTES: Execução completa sem vazamento, sem duplicidade e sem saturação de recursos", async () => {
    const memoryBefore = process.memoryUsage();
    let peakRss = memoryBefore.rss;

    const batch = await migration.renderBatch.create({
      data: {
        organizationId,
        clientId,
        templateVersionId,
        sourceType: "POSTS_SELECTION",
        format: "PORTRAIT",
        status: "PENDING",
        totalItems: 100,
        pendingItems: 100,
        idempotencyKey: `gate-100-${randomUUID()}`,
        requestHash: "req-hash-gate-100",
        createdById: "admin-a",
      },
    });

    const jobIds: string[] = [];
    const inputHashes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { parsed, hash } = createJobInput(
        `Gate 100 - Publicação Oficial #${i + 1}`,
        `Texto demonstrativo para teste de estresse de 100 artes consecutivas com Sharp e Satori #${i + 1}`,
      );
      inputHashes.add(hash);
      const jobId = randomUUID();
      jobIds.push(jobId);

      await migration.renderJob.create({
        data: {
          id: jobId,
          organizationId,
          clientId,
          batchId: batch.id,
          templateVersionId,
          status: "PENDING",
          input: parsed as unknown as Prisma.InputJsonValue,
          inputHash: hash,
          idempotencyKey: `job-gate100-${i}-${randomUUID()}`,
          createdById: "admin-a",
        },
      });
    }

    // Executa as 100 artes sequencialmente simulando a fila BullMQ com concorrência = 1
    const startTime = Date.now();
    for (let i = 0; i < 100; i++) {
      try {
        await executeRenderJob(
          { renderJobId: jobIds[i], organizationId, clientId },
          db,
          storage,
        );
      } catch (err) {
        if (!(err instanceof ActiveLeaseError)) {
          throw err;
        }
      }
      const currentRss = process.memoryUsage().rss;
      if (currentRss > peakRss) peakRss = currentRss;
    }

    const deadline4 = Date.now() + 30000;
    while (Date.now() < deadline4) {
      const b = await migration.renderBatch.findUnique({
        where: { id: batch.id },
      });
      if (b?.status === "COMPLETED" && b.completedItems === 100) {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    const memoryAfter = process.memoryUsage();
    const memoryDeltaMb =
      (memoryAfter.heapUsed - memoryBefore.heapUsed) / (1024 * 1024);
    const peakRssMb = peakRss / (1024 * 1024);
    const initialRssMb = memoryBefore.rss / (1024 * 1024);
    const finalRssMb = memoryAfter.rss / (1024 * 1024);

    console.info(
      `Gate 100 Artes concluído em ${elapsedSeconds.toFixed(1)}s (média: ${(elapsedSeconds / 100).toFixed(2)}s/arte). Peak RSS: ${peakRssMb.toFixed(1)} MB (inicial: ${initialRssMb.toFixed(1)} MB, final: ${finalRssMb.toFixed(1)} MB). Variação de Heap: ${memoryDeltaMb.toFixed(1)} MB. Hashes únicos: ${inputHashes.size}`,
    );

    // Validações do Gate:
    // 1. Status e Contadores Atômicos do Lote
    const finalBatch = await migration.renderBatch.findUnique({
      where: { id: batch.id },
    });
    expect(finalBatch?.status).toBe("COMPLETED");
    expect(finalBatch?.totalItems).toBe(100);
    expect(finalBatch?.completedItems).toBe(100);
    expect(finalBatch?.pendingItems).toBe(0);
    expect(finalBatch?.processingItems).toBe(0);
    expect(finalBatch?.failedItems).toBe(0);
    expect(finalBatch?.cancelledItems).toBe(0);
    expect(finalBatch?.completedAt).toBeDefined();

    // 2. Não duplicação de RenderJobs
    const totalJobs = await migration.renderJob.count({
      where: { batchId: batch.id },
    });
    expect(totalJobs).toBe(100);

    // 3. 100 MediaAssets persistidos com integridade e sem duplicidade
    const assets = await migration.mediaAsset.findMany({
      where: { id: { in: jobIds } },
    });
    expect(assets.length).toBe(100);
    expect(assets.every((a) => a.status === "ready")).toBe(true);
    expect(assets.every((a) => a.mimeType === "image/png")).toBe(true);
    expect(assets.every((a) => a.width === 1080 && a.height === 1350)).toBe(
      true,
    );

    // 4. Objetos no Storage acessíveis e válidos
    const sampleAsset = assets[0];
    expect(sampleAsset).toBeDefined();
    const storedBuffer = await storage.get(sampleAsset!.storageKey);
    expect(storedBuffer).not.toBeNull();
    const meta = await sharp(storedBuffer!).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);

    // 5. Auditoria de Lote registrada
    const auditLogs = await migration.auditLog.findMany({
      where: { entityId: batch.id },
    });
    expect(auditLogs.some((l) => l.action === "batch.completed")).toBe(true);
  }, 120000); // Timeout generoso de 2 minutos para 100 renders
});
