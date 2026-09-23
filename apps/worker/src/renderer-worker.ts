import { Worker, type Job, UnrecoverableError } from "bullmq";
import type { Redis } from "ioredis";
import { randomUUID, createHash } from "node:crypto";
import {
  asRendererActor,
  asSystemRendererDiscovery,
  type PrismaClient,
  type Prisma,
} from "@socialflow/db";
import {
  RENDER_QUEUE_NAME,
  type RenderJobData,
  createRenderQueue,
  closeRenderQueue,
  getRenderQueueJobId,
} from "@socialflow/api/render-queue.js";
import {
  validateImage,
  MAX_IMAGE_BYTES,
  type MediaStorage,
} from "@socialflow/api/media-storage.js";
import {
  renderArtwork,
  hashRenderInput,
  RENDERER_VERSION,
  type ArtworkRenderResult,
} from "@socialflow/render";
import {
  designTemplateSpecSchema,
  artworkInputSchema,
  sanitizeErrorMessage,
  computeBatchAggregateStatus,
} from "@socialflow/contracts";
import { z } from "zod";

export const RENDER_LEASE_MS = 5 * 60 * 1000; // 5 minutos de lease

export class InactiveTenantError extends Error {
  readonly code = "INACTIVE_TENANT";
  constructor(message = "Tenant inactive or invalid") {
    super(message);
    this.name = "InactiveTenantError";
  }
}

export class ActiveLeaseError extends Error {
  readonly code = "ACTIVE_LEASE";
  constructor(message = "Render job is currently locked by active lease") {
    super(message);
    this.name = "ActiveLeaseError";
  }
}

export { sanitizeErrorMessage };

export async function updateBatchCounters(
  tx: Prisma.TransactionClient,
  batchId: string,
  organizationId: string,
  clientId: string,
): Promise<void> {
  const [
    pendingItems,
    processingItems,
    completedItems,
    failedItems,
    cancelledItems,
  ] = await Promise.all([
    tx.renderJob.count({
      where: { organizationId, clientId, batchId, status: "PENDING" },
    }),
    tx.renderJob.count({
      where: { organizationId, clientId, batchId, status: "PROCESSING" },
    }),
    tx.renderJob.count({
      where: { organizationId, clientId, batchId, status: "COMPLETED" },
    }),
    tx.renderJob.count({
      where: { organizationId, clientId, batchId, status: "FAILED" },
    }),
    tx.renderJob.count({
      where: { organizationId, clientId, batchId, status: "CANCELLED" },
    }),
  ]);

  const batch = await tx.renderBatch.findFirst({
    where: { id: batchId, organizationId, clientId },
    select: { cancelRequestedAt: true, status: true, totalItems: true },
  });

  if (!batch) return;

  const isBatchTerminal = pendingItems === 0 && processingItems === 0;
  const newBatchStatus = computeBatchAggregateStatus({
    totalItems: batch.totalItems,
    pendingItems,
    processingItems,
    completedItems,
    failedItems,
    cancelledItems,
    cancelRequestedAt: batch.cancelRequestedAt,
  });

  const now = new Date();
  await tx.renderBatch.update({
    where: { id: batchId },
    data: {
      pendingItems,
      processingItems,
      completedItems,
      failedItems,
      cancelledItems,
      status: newBatchStatus,
      completedAt:
        isBatchTerminal && newBatchStatus !== "CANCELLED" ? now : null,
      cancelCompletedAt:
        isBatchTerminal && Boolean(batch.cancelRequestedAt) ? now : null,
    },
  });

  if (isBatchTerminal) {
    let action = "batch.completed";
    if (newBatchStatus === "CANCELLED") action = "batch.cancelled";
    else if (
      newBatchStatus === "FAILED" ||
      newBatchStatus === "PARTIALLY_FAILED"
    ) {
      action = "batch.completed_with_failures";
    }

    await tx.auditLog.create({
      data: {
        organizationId,
        actorUserId: "system:renderer",
        entityId: batchId,
        action,
      },
    });
  }
}

const renderPayloadSchema = z.strictObject({
  renderJobId: z.string().min(1),
  organizationId: z.string().min(1),
  clientId: z.string().min(1),
});

export interface RendererWorkerDependencies {
  storage?: MediaStorage;
  onBeforeAcquisition?: () => Promise<void>;
  onAfterAcquisition?: (acquired: boolean) => Promise<void>;
  onBeforeRender?: () => Promise<void>;
  onBeforeStoragePut?: () => Promise<void>;
  onBeforeFinalize?: () => Promise<void>;
  concurrency?: number;
}

export async function executeRenderJob(
  data: unknown,
  db: PrismaClient,
  storage: MediaStorage,
  deps: RendererWorkerDependencies = {},
): Promise<void> {
  // 1. Validar o payload mínimo
  const parseResult = renderPayloadSchema.safeParse(data);
  if (!parseResult.success) {
    throw new UnrecoverableError("Invalid render job payload");
  }
  const { renderJobId, organizationId, clientId } = parseResult.data;

  // 2 e 3. Adquirir atomicamente o RenderJob sob asRendererActor()
  const executionToken = randomUUID();
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + RENDER_LEASE_MS);

  if (deps.onBeforeAcquisition) {
    await deps.onBeforeAcquisition();
  }

  type AcquisitionResult =
    | { status: "ACQUIRED"; isRecovery: boolean; attemptNumber: number }
    | { status: "SKIPPED"; reason: string };

  let acquisition: AcquisitionResult;
  try {
    acquisition = await asRendererActor(
      db,
      { organizationId, clientId },
      async (tx) => {
        const existing = await tx.renderJob.findFirst({
          where: { id: renderJobId, organizationId, clientId },
          select: {
            id: true,
            status: true,
            leaseExpiresAt: true,
            attemptNumber: true,
          },
        });

        if (!existing) {
          return { status: "SKIPPED", reason: "NOT_FOUND" };
        }

        if (
          existing.status === "COMPLETED" ||
          existing.status === "FAILED" ||
          existing.status === "CANCELLED"
        ) {
          return { status: "SKIPPED", reason: `ALREADY_${existing.status}` };
        }

        const isRecovery =
          existing.status === "PROCESSING" &&
          existing.leaseExpiresAt !== null &&
          existing.leaseExpiresAt <= now;
        const isPending = existing.status === "PENDING";

        if (!isPending && !isRecovery) {
          return { status: "SKIPPED", reason: "ACTIVE_LEASE" };
        }

        const updateResult = await tx.renderJob.updateMany({
          where: {
            id: renderJobId,
            organizationId,
            clientId,
            status: existing.status,
            ...(isRecovery
              ? { leaseExpiresAt: existing.leaseExpiresAt }
              : { status: "PENDING" }),
          },
          data: {
            status: "PROCESSING",
            executionToken,
            queueJobId: getRenderQueueJobId(renderJobId),
            attemptNumber: { increment: 1 },
            leaseExpiresAt,
            errorCode: null,
            errorMessage: null,
          },
        });

        if (updateResult.count !== 1) {
          return { status: "SKIPPED", reason: "CONCURRENT_CONFLICT" };
        }

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: "system:renderer",
            entityId: renderJobId,
            action: isRecovery ? "render.recovered" : "render.started",
          },
        });

        return {
          status: "ACQUIRED",
          isRecovery,
          attemptNumber: existing.attemptNumber + 1,
        };
      },
    );
  } catch (tenantErr) {
    const isInactiveTenant =
      tenantErr instanceof Error &&
      tenantErr.message ===
        "Invalid or inactive tenant scope for renderer execution";

    if (isInactiveTenant) {
      console.warn(
        JSON.stringify({
          event: "render_tenant_inactive_or_invalid",
          renderJobId,
          organizationId,
          clientId,
          error: "Tenant inactive or invalid",
        }),
      );
      throw new UnrecoverableError("Tenant inactive or invalid");
    }

    console.error(
      JSON.stringify({
        event: "render_acquisition_db_error",
        renderJobId,
        organizationId,
        clientId,
        error: sanitizeErrorMessage(
          tenantErr instanceof Error ? tenantErr.message : String(tenantErr),
        ),
      }),
    );
    throw tenantErr;
  }

  if (deps.onAfterAcquisition) {
    await deps.onAfterAcquisition(acquisition.status === "ACQUIRED");
  }

  if (acquisition.status !== "ACQUIRED") {
    if (acquisition.reason === "NOT_FOUND") {
      console.warn(
        JSON.stringify({
          event: "render_job_not_found",
          renderJobId,
        }),
      );
      throw new UnrecoverableError("Render job not found");
    }

    if (
      acquisition.reason === "ACTIVE_LEASE" ||
      acquisition.reason === "CONCURRENT_CONFLICT"
    ) {
      console.info(
        JSON.stringify({
          event: "render_job_acquisition_locked",
          renderJobId,
          reason: acquisition.reason,
        }),
      );
      throw new ActiveLeaseError(
        `Render job is currently locked (${acquisition.reason})`,
      );
    }

    console.info(
      JSON.stringify({
        event: "render_job_acquisition_skipped",
        renderJobId,
        reason: acquisition.reason,
      }),
    );
    return;
  }

  // Helpers para encerramento com fencing token
  async function markPermanentFailure(
    errorCode: string,
    rawErrorMessage: string,
  ): Promise<void> {
    try {
      await asRendererActor(db, { organizationId, clientId }, async (tx) => {
        const res = await tx.renderJob.updateMany({
          where: {
            id: renderJobId,
            organizationId,
            clientId,
            executionToken,
          },
          data: {
            status: "FAILED",
            errorCode,
            errorMessage: sanitizeErrorMessage(rawErrorMessage),
            leaseExpiresAt: null,
            executionToken: null,
          },
        });
        if (res.count === 1) {
          await tx.auditLog.create({
            data: {
              organizationId,
              actorUserId: "system:renderer",
              entityId: renderJobId,
              action: "render.failed",
            },
          });

          const currentJob = await tx.renderJob.findFirst({
            where: { id: renderJobId, organizationId, clientId },
            select: { batchId: true },
          });
          if (currentJob?.batchId) {
            await updateBatchCounters(
              tx,
              currentJob.batchId,
              organizationId,
              clientId,
            );
          }
        }
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "render_mark_failed_error",
          renderJobId,
          errorCode,
          error: sanitizeErrorMessage(
            err instanceof Error ? err.message : String(err),
          ),
        }),
      );
    }
  }

  async function releaseTransientJob(): Promise<void> {
    try {
      await asRendererActor(db, { organizationId, clientId }, async (tx) => {
        await tx.renderJob.updateMany({
          where: {
            id: renderJobId,
            organizationId,
            clientId,
            executionToken,
          },
          data: {
            status: "PENDING",
            leaseExpiresAt: null,
            executionToken: null,
          },
        });
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "render_release_transient_error",
          renderJobId,
          error: sanitizeErrorMessage(
            err instanceof Error ? err.message : String(err),
          ),
        }),
      );
    }
  }

  try {
    // 4. Carregar e validar novamente template, especificação, input e versão do renderer
    const jobData = await asRendererActor(
      db,
      { organizationId, clientId },
      async (tx) => {
        return tx.renderJob.findFirst({
          where: {
            id: renderJobId,
            organizationId,
            clientId,
            executionToken,
          },
          include: {
            templateVersion: {
              include: {
                template: true,
              },
            },
            batch: true,
            backgroundMediaAsset: true,
            logoMediaAsset: true,
          },
        });
      },
    );

    if (!jobData) {
      throw new Error("Render job lost or superseded during execution");
    }

    // Cancelamento cooperativo: se o lote solicitou cancelamento, pular com segurança
    if (jobData.batch?.cancelRequestedAt) {
      await asRendererActor(db, { organizationId, clientId }, async (tx) => {
        await tx.renderJob.updateMany({
          where: {
            id: renderJobId,
            organizationId,
            clientId,
            executionToken,
          },
          data: {
            status: "CANCELLED",
            executionToken: null,
            leaseExpiresAt: null,
          },
        });
        if (jobData.batchId) {
          await updateBatchCounters(
            tx,
            jobData.batchId,
            organizationId,
            clientId,
          );
        }
      });
      console.info(
        JSON.stringify({
          event: "render_job_cancelled_due_to_batch",
          renderJobId,
          batchId: jobData.batchId,
        }),
      );
      return;
    }

    if (!jobData.templateVersion) {
      await markPermanentFailure(
        "TEMPLATE_NOT_FOUND",
        "Template version not found",
      );
      throw new UnrecoverableError("Template version not found");
    }

    if (jobData.templateVersion.template.status !== "ACTIVE") {
      await markPermanentFailure(
        "TEMPLATE_INACTIVE",
        "Design template is archived or inactive",
      );
      throw new UnrecoverableError("Design template is archived or inactive");
    }

    if (jobData.templateVersion.rendererVersion !== RENDERER_VERSION) {
      await markPermanentFailure(
        "UNSUPPORTED_RENDERER_VERSION",
        `Unsupported renderer version: ${jobData.templateVersion.rendererVersion}`,
      );
      throw new UnrecoverableError("Unsupported renderer version");
    }

    const specParse = designTemplateSpecSchema.safeParse(
      jobData.templateVersion.spec,
    );
    if (!specParse.success) {
      await markPermanentFailure(
        "INVALID_TEMPLATE_SPEC",
        "Template spec validation failed",
      );
      throw new UnrecoverableError("Invalid template spec");
    }
    const spec = specParse.data;

    const inputParse = artworkInputSchema.safeParse(jobData.input);
    if (!inputParse.success) {
      await markPermanentFailure(
        "INVALID_INPUT",
        "Artwork input validation failed",
      );
      throw new UnrecoverableError("Invalid artwork input");
    }
    const input = inputParse.data;

    const expectedInputHash = hashRenderInput(spec, input);
    if (expectedInputHash !== jobData.inputHash) {
      await markPermanentFailure(
        "INPUT_HASH_MISMATCH",
        "Input hash does not match template spec and input",
      );
      throw new UnrecoverableError("Input hash mismatch");
    }

    // 5. Validar mídias opcionais via banco sob RLS
    const bgAsset = jobData.backgroundMediaAsset;
    if (jobData.backgroundMediaAssetId) {
      if (
        !bgAsset ||
        bgAsset.status !== "ready" ||
        bgAsset.archived ||
        !bgAsset.sha256 ||
        !bgAsset.byteSize ||
        bgAsset.byteSize > MAX_IMAGE_BYTES
      ) {
        await markPermanentFailure(
          "SOURCE_MEDIA_INVALID",
          "Background media asset is missing, unready or invalid",
        );
        throw new UnrecoverableError("Background media asset is invalid");
      }
    }

    const logoAsset = jobData.logoMediaAsset;
    if (jobData.logoMediaAssetId) {
      if (
        !logoAsset ||
        logoAsset.status !== "ready" ||
        logoAsset.archived ||
        !logoAsset.sha256 ||
        !logoAsset.byteSize ||
        logoAsset.byteSize > MAX_IMAGE_BYTES
      ) {
        await markPermanentFailure(
          "SOURCE_MEDIA_INVALID",
          "Logo media asset is missing, unready or invalid",
        );
        throw new UnrecoverableError("Logo media asset is invalid");
      }
    }

    // 6 e 7. Baixar os bytes pelo storage e conferir o SHA-256 contra o banco
    let backgroundImage: Buffer | undefined;
    if (bgAsset) {
      try {
        backgroundImage = await storage.get(bgAsset.storageKey);
      } catch (downloadErr) {
        console.error(
          JSON.stringify({
            event: "render_source_background_download_failed",
            renderJobId,
            mediaAssetId: bgAsset.id,
          }),
        );
        throw downloadErr;
      }
      if (!backgroundImage) {
        await markPermanentFailure(
          "SOURCE_MEDIA_INVALID",
          "Background media data could not be downloaded",
        );
        throw new UnrecoverableError("Background media data missing");
      }
      const actualBgHash = createHash("sha256")
        .update(backgroundImage)
        .digest("hex");
      if (actualBgHash !== bgAsset.sha256) {
        await markPermanentFailure(
          "MEDIA_HASH_MISMATCH",
          "Background media SHA-256 mismatch against database record",
        );
        throw new UnrecoverableError("Background media hash mismatch");
      }
    }

    let logoImage: Buffer | undefined;
    if (logoAsset) {
      try {
        logoImage = await storage.get(logoAsset.storageKey);
      } catch (downloadErr) {
        console.error(
          JSON.stringify({
            event: "render_source_logo_download_failed",
            renderJobId,
            mediaAssetId: logoAsset.id,
          }),
        );
        throw downloadErr;
      }
      if (!logoImage) {
        await markPermanentFailure(
          "SOURCE_MEDIA_INVALID",
          "Logo media data could not be downloaded",
        );
        throw new UnrecoverableError("Logo media data missing");
      }
      const actualLogoHash = createHash("sha256")
        .update(logoImage)
        .digest("hex");
      if (actualLogoHash !== logoAsset.sha256) {
        await markPermanentFailure(
          "MEDIA_HASH_MISMATCH",
          "Logo media SHA-256 mismatch against database record",
        );
        throw new UnrecoverableError("Logo media hash mismatch");
      }
    }

    // 8. Executar renderArtwork() do pacote @socialflow/render
    if (deps.onBeforeRender) {
      await deps.onBeforeRender();
    }

    let rendered: ArtworkRenderResult;
    try {
      rendered = await renderArtwork({
        spec,
        input,
        backgroundImage,
        logoImage,
      });
    } catch (renderErr) {
      await markPermanentFailure(
        "RENDER_FAILED",
        renderErr instanceof Error
          ? renderErr.message
          : "Artwork render failed",
      );
      throw new UnrecoverableError("Artwork rendering failed");
    }

    // Cancelamento cooperativo antes do upload: se o lote solicitou cancelamento, não gravar no storage
    if (jobData.batchId) {
      const batchState = await asRendererActor(
        db,
        { organizationId, clientId },
        async (tx) => {
          return tx.renderBatch.findFirst({
            where: { id: jobData.batchId!, organizationId, clientId },
            select: { cancelRequestedAt: true },
          });
        },
      );

      if (batchState?.cancelRequestedAt) {
        await asRendererActor(db, { organizationId, clientId }, async (tx) => {
          await tx.renderJob.updateMany({
            where: {
              id: renderJobId,
              organizationId,
              clientId,
              executionToken,
            },
            data: {
              status: "CANCELLED",
              executionToken: null,
              leaseExpiresAt: null,
            },
          });
          if (jobData.batchId) {
            await updateBatchCounters(
              tx,
              jobData.batchId,
              organizationId,
              clientId,
            );
          }
        });
        console.info(
          JSON.stringify({
            event: "render_job_cancelled_before_storage_upload",
            renderJobId,
            batchId: jobData.batchId,
          }),
        );
        return;
      }
    }

    // 9. Reservar o MediaAsset determinístico (Opção C: armazenamento por job ID em conformidade com RLS e check constraints)
    const targetStorageKey = `media/${organizationId}/${clientId}/${renderJobId}`;
    const targetMediaAssetId = renderJobId;

    await asRendererActor(db, { organizationId, clientId }, async (tx) => {
      const current = await tx.renderJob.findFirst({
        where: { id: renderJobId, organizationId, clientId, executionToken },
        select: { id: true },
      });
      if (!current) {
        throw new Error(
          "Execution token mismatch: lease lost before media reservation",
        );
      }

      await tx.mediaAsset.upsert({
        where: { id: renderJobId },
        create: {
          id: renderJobId,
          organizationId,
          clientId,
          name: `Artwork render ${jobData.inputHash.slice(0, 12)}`,
          storageKey: targetStorageKey,
          status: "pending",
        },
        update: {},
      });
    });

    // 10. Gravar o PNG no storage
    if (deps.onBeforeStoragePut) {
      await deps.onBeforeStoragePut();
    }

    try {
      await storage.put(targetStorageKey, rendered.data, rendered.mimeType);
    } catch (storageErr: unknown) {
      const isPrecondition =
        (storageErr as { name?: string }).name === "PreconditionFailed" ||
        (storageErr as { Code?: string }).Code === "PreconditionFailed" ||
        (storageErr as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 412 ||
        (storageErr as { code?: string }).code === "PreconditionFailed";

      if (isPrecondition) {
        // Objeto já existe: baixar e validar bytes, SHA-256 e dimensões
        try {
          const existingBytes = await storage.get(targetStorageKey);
          const validated = await validateImage(existingBytes);
          const existingSha256 = createHash("sha256")
            .update(existingBytes)
            .digest("hex");
          if (
            existingSha256 === rendered.sha256 &&
            existingBytes.length === rendered.byteSize &&
            validated.width === rendered.width &&
            validated.height === rendered.height &&
            validated.mimeType === "image/png"
          ) {
            console.info(
              JSON.stringify({
                event: "render_existing_matching_object_recovered",
                renderJobId,
              }),
            );
          } else {
            console.error(
              JSON.stringify({
                event: "render_existing_object_diverged",
                renderJobId,
              }),
            );
            await markPermanentFailure(
              "OUTPUT_OBJECT_CONFLICT",
              "An object already exists at storage key with divergent content",
            );
            throw new UnrecoverableError("Output object conflict in storage");
          }
        } catch (validateErr) {
          if (validateErr instanceof UnrecoverableError) throw validateErr;
          await markPermanentFailure(
            "OUTPUT_OBJECT_CONFLICT",
            "An object already exists at storage key and validation failed",
          );
          throw new UnrecoverableError("Output object validation failed");
        }
      } else {
        console.error(
          JSON.stringify({
            event: "render_storage_upload_failed",
            renderJobId,
            error: sanitizeErrorMessage(
              storageErr instanceof Error
                ? storageErr.message
                : String(storageErr),
            ),
          }),
        );
        throw storageErr;
      }
    }

    // 11. Finalizar atomicamente com fencing token
    if (deps.onBeforeFinalize) {
      await deps.onBeforeFinalize();
    }

    await asRendererActor(db, { organizationId, clientId }, async (tx) => {
      await tx.mediaAsset.update({
        where: { id: targetMediaAssetId },
        data: {
          status: "ready",
          mimeType: "image/png",
          byteSize: rendered.byteSize,
          width: rendered.width,
          height: rendered.height,
          sha256: rendered.sha256,
        },
      });

      const finalizeResult = await tx.renderJob.updateMany({
        where: {
          id: renderJobId,
          organizationId,
          clientId,
          executionToken,
        },
        data: {
          status: "COMPLETED",
          outputMediaAssetId: targetMediaAssetId,
          completedAt: new Date(),
          leaseExpiresAt: null,
          executionToken: null,
        },
      });

      if (finalizeResult.count !== 1) {
        throw new Error(
          "Fencing token mismatch on finalization: lease was superseded",
        );
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: "system:renderer",
          entityId: renderJobId,
          action: "render.completed",
        },
      });

      if (jobData.batchId) {
        await updateBatchCounters(
          tx,
          jobData.batchId,
          organizationId,
          clientId,
        );
      }
    });

    console.info(
      JSON.stringify({
        event: "render_completed_successfully",
        renderJobId,
        outputMediaAssetId: renderJobId,
        format: spec.format,
        sha256: rendered.sha256,
      }),
    );
  } catch (err) {
    if (err instanceof UnrecoverableError) {
      throw err;
    }
    await releaseTransientJob();
    console.error(
      JSON.stringify({
        event: "render_execution_transient_error",
        renderJobId,
        error: sanitizeErrorMessage(
          err instanceof Error ? err.message : String(err),
        ),
      }),
    );
    throw err;
  }
}

export async function runRendererReconciliationCycle(
  db: PrismaClient,
  redis: Redis,
): Promise<{ recoveredJobs: number }> {
  let recoveredJobs = 0;
  const queue = createRenderQueue(redis);

  try {
    const candidates = await asSystemRendererDiscovery(db, async (tx) => {
      return tx.$queryRaw<
        Array<{
          renderJobId: string;
          organizationId: string;
          clientId: string;
          status: "PENDING" | "PROCESSING";
          queueJobId: string | null;
          leaseExpiresAt: Date | null;
          updatedAt: Date;
          batchId: string | null;
        }>
      >`
        SELECT "renderJobId", "organizationId", "clientId", status, "queueJobId", "leaseExpiresAt", "updatedAt", "batchId"
        FROM discover_reconcilable_render_jobs()
      `;
    });

    for (const candidate of candidates) {
      const expectedJobId = getRenderQueueJobId(candidate.renderJobId);

      try {
        const job = await queue.getJob(expectedJobId);
        let shouldEnqueue = false;

        if (!job) {
          shouldEnqueue = true;
        } else {
          const state = await job.getState();
          if (state === "completed" || state === "failed") {
            try {
              await job.remove();
            } catch {
              // Ignore removal error
            }
            shouldEnqueue = true;
          }
        }

        if (shouldEnqueue) {
          await queue.add(
            "render-artwork",
            {
              renderJobId: candidate.renderJobId,
              organizationId: candidate.organizationId,
              clientId: candidate.clientId,
            },
            {
              jobId: expectedJobId,
              removeOnComplete: 100,
              removeOnFail: 500,
            },
          );

          await asRendererActor(
            db,
            {
              organizationId: candidate.organizationId,
              clientId: candidate.clientId,
            },
            async (tx) => {
              await tx.renderJob.updateMany({
                where: {
                  id: candidate.renderJobId,
                  organizationId: candidate.organizationId,
                  clientId: candidate.clientId,
                  status: candidate.status,
                },
                data: {
                  queueJobId: expectedJobId,
                  ...(candidate.status === "PROCESSING"
                    ? {
                        status: "PENDING",
                        leaseExpiresAt: null,
                        executionToken: null,
                      }
                    : {}),
                },
              });
            },
          );

          recoveredJobs++;
          console.info(
            JSON.stringify({
              event: "renderer_reconciliation_reenqueued",
              renderJobId: candidate.renderJobId,
              status: candidate.status,
            }),
          );
        }
      } catch (jobErr) {
        console.error(
          JSON.stringify({
            event: "renderer_reconciliation_job_check_error",
            renderJobId: candidate.renderJobId,
            error: sanitizeErrorMessage(
              jobErr instanceof Error ? jobErr.message : String(jobErr),
            ),
          }),
        );
      }
    }

    // Reconciliar contadores e status de lotes ativos através de contexto protegido do reconciliador
    const activeBatches = await asSystemRendererDiscovery(db, async (tx) => {
      return tx.$queryRaw<
        Array<{
          batchId: string;
          organizationId: string;
          clientId: string;
        }>
      >`
        SELECT "batchId", "organizationId", "clientId"
        FROM discover_active_render_batches()
      `;
    });

    for (const b of activeBatches) {
      try {
        await asRendererActor(
          db,
          { organizationId: b.organizationId, clientId: b.clientId },
          async (tx) => {
            await updateBatchCounters(
              tx,
              b.batchId,
              b.organizationId,
              b.clientId,
            );
          },
        );
      } catch (batchErr) {
        console.error(
          JSON.stringify({
            event: "renderer_reconciliation_batch_error",
            batchId: b.batchId,
            error: sanitizeErrorMessage(
              batchErr instanceof Error ? batchErr.message : String(batchErr),
            ),
          }),
        );
      }
    }
  } finally {
    await closeRenderQueue(queue);
  }

  return { recoveredJobs };
}

export async function runRendererStartupReconciliation(
  db: PrismaClient,
  redis: Redis,
): Promise<{ recoveredJobs: number }> {
  return runRendererReconciliationCycle(db, redis);
}

export interface RendererReconcilerOptions {
  intervalMs?: number;
}

export class RendererReconciler {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private stopped = false;
  public readonly intervalMs: number;

  constructor(
    private readonly db: PrismaClient,
    private readonly redis: Redis,
    options: RendererReconcilerOptions = {},
  ) {
    this.intervalMs = Math.max(100, options.intervalMs ?? 60_000);
  }

  async runReconciliation(): Promise<{ recoveredJobs: number }> {
    if (this.isRunning || this.stopped) {
      return { recoveredJobs: 0 };
    }
    this.isRunning = true;
    try {
      return await runRendererReconciliationCycle(this.db, this.redis);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "renderer_reconciliation_cycle_error",
          error: sanitizeErrorMessage(
            err instanceof Error ? err.message : String(err),
          ),
        }),
      );
      return { recoveredJobs: 0 };
    } finally {
      this.isRunning = false;
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.runReconciliation();
    }, this.intervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get active(): boolean {
    return this.timer !== null && !this.stopped;
  }
}

export function createRendererWorker(
  db: PrismaClient,
  redis: Redis,
  storage: MediaStorage,
  deps: RendererWorkerDependencies = {},
): Worker<RenderJobData> {
  const worker = new Worker<RenderJobData>(
    RENDER_QUEUE_NAME,
    async (job: Job<RenderJobData>) => {
      await executeRenderJob(job.data, db, deps.storage ?? storage, deps);
    },
    {
      connection: redis,
      concurrency: deps.concurrency ?? 1,
    },
  );

  worker.on("error", (err) => {
    console.error(
      JSON.stringify({
        event: "renderer_worker_error",
        error: sanitizeErrorMessage(err.message),
      }),
    );
  });

  worker.on("failed", (job, err) => {
    console.error(
      JSON.stringify({
        event: "renderer_job_failed",
        renderJobId: job?.data?.renderJobId,
        error: sanitizeErrorMessage(err.message),
      }),
    );
  });

  return worker;
}
