import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { asActor, type PrismaClient, type Prisma } from "@socialflow/db";
import type { Config } from "@socialflow/config";
import {
  SCHEDULE_QUEUE_NAME,
  type ScheduleJobData,
  getScheduleQueue,
} from "@socialflow/api/scheduler-queue.js";
import {
  preparePublication,
  executePublication,
  isTransientError,
} from "@socialflow/api/publication-service.js";
import { MetaPublisherAdapter } from "@socialflow/api/meta-publisher.js";

export const LATE_TOLERANCE_MS = 15 * 60 * 1000; // 15 minutos

export interface SchedulerWorkerDependencies {
  publisher?: MetaPublisherAdapter;
  onBeforePublish?: () => Promise<void>;
  concurrency?: number;
}

export async function runStartupReconciliation(
  db: PrismaClient,
  redis: Redis,
): Promise<{
  recoveredJobs: number;
  flaggedLate: number;
  flaggedOrphan: number;
}> {
  let recoveredJobs = 0;
  let flaggedLate = 0;
  let flaggedOrphan = 0;

  const now = new Date();
  const queue = getScheduleQueue(redis);

  // 1. Agendamentos em SCHEDULED ou ENQUEUED
  const pendingSchedules = await db.publicationSchedule.findMany({
    where: {
      status: { in: ["SCHEDULED", "ENQUEUED"] },
    },
  });

  for (const schedule of pendingSchedules) {
    const delayMs = now.getTime() - schedule.scheduledForUtc.getTime();

    // Política de atraso: atraso > 15 minutos vai para revisão manual sem publicar
    if (delayMs > LATE_TOLERANCE_MS) {
      await asActor(db, schedule.createdById, async (tx) => {
        await tx.publicationSchedule.update({
          where: { id: schedule.id },
          data: {
            status: "REQUIRES_RECONCILIATION",
            failureReason:
              "Atraso de execução superior a 15 minutos detectado na inicialização. Requer verificação manual.",
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: schedule.organizationId,
            actorUserId: schedule.createdById,
            entityId: schedule.id,
            action: "schedule.reconciliation_required",
          },
        });
      });
      flaggedLate++;
      continue;
    }

    // Verifica se o job correspondente existe no BullMQ
    try {
      const job = await queue.getJob(schedule.jobId);
      if (!job) {
        // Recria job ausente no Redis
        const remainingDelay = Math.max(
          0,
          schedule.scheduledForUtc.getTime() - Date.now(),
        );
        await queue.add(
          "publish-scheduled-post",
          {
            scheduleId: schedule.id,
            version: schedule.version,
            organizationId: schedule.organizationId,
            clientId: schedule.clientId,
            postId: schedule.postId,
          },
          {
            jobId: schedule.jobId,
            delay: remainingDelay,
            removeOnComplete: 100,
            removeOnFail: 500,
          },
        );

        if (schedule.status !== "ENQUEUED") {
          await asActor(db, schedule.createdById, async (tx) => {
            await tx.publicationSchedule.update({
              where: { id: schedule.id },
              data: { status: "ENQUEUED" },
            });
            await tx.auditLog.create({
              data: {
                organizationId: schedule.organizationId,
                actorUserId: schedule.createdById,
                entityId: schedule.id,
                action: "schedule.enqueued",
              },
            });
          });
        }
        recoveredJobs++;
      }
    } catch (jobErr) {
      console.error(
        JSON.stringify({
          event: "reconciliation_job_check_error",
          scheduleId: schedule.id,
          error: jobErr instanceof Error ? jobErr.message : String(jobErr),
        }),
      );
    }
  }

  // 2. Agendamentos presos em PROCESSING com lease expirada
  const processingSchedules = await db.publicationSchedule.findMany({
    where: { status: "PROCESSING" },
    include: { publicationAttempts: true },
  });

  for (const schedule of processingSchedules) {
    const activeAttempts = schedule.publicationAttempts.filter((a) =>
      ["PROCESSING", "CONTAINER_CREATED"].includes(a.status),
    );

    const hasActiveLease = activeAttempts.some(
      (a) => a.leaseExpiresAt && a.leaseExpiresAt > now,
    );

    if (
      !hasActiveLease &&
      (activeAttempts.length > 0 ||
        now.getTime() - schedule.updatedAt.getTime() > 5 * 60 * 1000)
    ) {
      // Lease expirada ou processo abandonado sem tentativas ativas. Envia para reconciliação manual
      await asActor(db, schedule.createdById, async (tx) => {
        await tx.publicationSchedule.update({
          where: { id: schedule.id },
          data: {
            status: "REQUIRES_RECONCILIATION",
            failureReason:
              "Execução anterior abandonada com lease expirada. Requer reconciliação manual.",
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: schedule.organizationId,
            actorUserId: schedule.createdById,
            entityId: schedule.id,
            action: "schedule.reconciliation_required",
          },
        });
      });
      flaggedOrphan++;
    }
  }

  return { recoveredJobs, flaggedLate, flaggedOrphan };
}

export async function processScheduleJob(
  job: {
    data: ScheduleJobData;
    id?: string;
    attemptsMade?: number;
    opts?: { attempts?: number };
  },
  db: PrismaClient,
  redis: Redis,
  config: Config,
  dependencies?: SchedulerWorkerDependencies,
): Promise<{ status: string }> {
  const publisher =
    dependencies?.publisher ??
    new MetaPublisherAdapter({ graphBaseUrl: config.META_GRAPH_URL });

  const { scheduleId, version, organizationId, clientId, postId } = job.data;

  const schedule = await db.publicationSchedule.findFirst({
    where: { id: scheduleId, organizationId, clientId, postId },
  });

  if (!schedule) {
    return { status: "skipped_not_found" };
  }

  // 1. Verificação de versão obsoleta (ex: reprogramação recente)
  if (schedule.version !== version) {
    return { status: "skipped_obsolete_version" };
  }

  // 2. Verificação de status
  if (schedule.status === "CANCELLED") {
    return { status: "skipped_cancelled" };
  }

  if (
    [
      "PUBLISHED",
      "PARTIALLY_PUBLISHED",
      "DEAD_LETTER",
      "REQUIRES_RECONCILIATION",
    ].includes(schedule.status)
  ) {
    return { status: "skipped_already_terminal" };
  }

  // 3. Política de atraso de jobs: tolerância de até 15 minutos
  const now = new Date();
  const delayMs = now.getTime() - schedule.scheduledForUtc.getTime();
  if (delayMs > LATE_TOLERANCE_MS) {
    await asActor(db, schedule.createdById, async (tx) => {
      await tx.publicationSchedule.update({
        where: { id: schedule.id },
        data: {
          status: "REQUIRES_RECONCILIATION",
          failureReason: `Atraso de execução superior a 15 minutos (${Math.round(delayMs / 60000)} minutos de atraso). Requer revisão manual.`,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: schedule.organizationId,
          actorUserId: schedule.createdById,
          entityId: schedule.id,
          action: "schedule.reconciliation_required",
        },
      });
    });
    return { status: "requires_reconciliation_late" };
  }

  // 4. Marcação atômica de PROCESSING no PostgreSQL
  await asActor(db, schedule.createdById, async (tx) => {
    await tx.publicationSchedule.update({
      where: { id: schedule.id },
      data: { status: "PROCESSING" },
    });
    await tx.auditLog.create({
      data: {
        organizationId: schedule.organizationId,
        actorUserId: schedule.createdById,
        entityId: schedule.id,
        action: "schedule.started",
      },
    });
  });

  if (!config.CREDENTIAL_MASTER_KEY) {
    throw new Error("CREDENTIAL_MASTER_KEY não configurada no ambiente.");
  }

  // 5. Preparação dos alvos utilizando o serviço comum
  let prepResult;
  try {
    prepResult = await asActor(db, schedule.createdById, async (tx) => {
      return preparePublication({
        tx,
        organizationId: schedule.organizationId,
        clientId: schedule.clientId,
        postId: schedule.postId,
        socialAccountIds: schedule.targetAccountIds,
        mediaAssetId: schedule.mediaAssetId,
        masterKey: config.CREDENTIAL_MASTER_KEY!,
        scheduleId: schedule.id,
        allowSkippingPublished: true,
        auditCallback: (
          txScope: Prisma.TransactionClient,
          entityId: string,
          action: string,
        ) =>
          txScope.auditLog.create({
            data: {
              organizationId: schedule.organizationId,
              actorUserId: schedule.createdById,
              entityId,
              action,
            },
          }),
      });
    });
  } catch (prepErr) {
    // Falha permanente na preparação (ex: post rejeitado, conta excluída)
    await asActor(db, schedule.createdById, async (tx) => {
      await tx.publicationSchedule.update({
        where: { id: schedule.id },
        data: {
          status: "FAILED",
          failureReason:
            prepErr instanceof Error ? prepErr.message : String(prepErr),
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: schedule.organizationId,
          actorUserId: schedule.createdById,
          entityId: schedule.id,
          action: "schedule.failed",
        },
      });
    });
    return { status: "failed_preparation" };
  }

  if ("uncertainAccount" in prepResult && prepResult.uncertainAccount) {
    await asActor(db, schedule.createdById, async (tx) => {
      await tx.publicationSchedule.update({
        where: { id: schedule.id },
        data: {
          status: "REQUIRES_RECONCILIATION",
          failureReason:
            "Conta com resultado remoto incerto anterior aguardando reconciliação manual.",
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: schedule.organizationId,
          actorUserId: schedule.createdById,
          entityId: schedule.id,
          action: "schedule.reconciliation_required",
        },
      });
    });
    return { status: "requires_reconciliation_uncertain" };
  }

  // 6. Execução das publicações com MetaPublisherAdapter fora de transação
  let execResult;
  try {
    execResult = await executePublication({
      txRunner: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
        asActor(db, schedule.createdById, fn),
      auditCallback: (
        txScope: Prisma.TransactionClient,
        entityId: string,
        action: string,
      ) =>
        txScope.auditLog.create({
          data: {
            organizationId: schedule.organizationId,
            actorUserId: schedule.createdById,
            entityId,
            action,
          },
        }),
      publisher,
      prepResult,
      organizationId: schedule.organizationId,
      clientId: schedule.clientId,
      appUrl: config.APP_URL,
      redis,
      onBeforePublish: dependencies?.onBeforePublish,
    });
  } catch (execErr) {
    const isTransient = isTransientError(execErr);
    const attemptsMade = job.attemptsMade ?? 0;
    const maxAttempts = job.opts?.attempts ?? 4;
    if (isTransient && attemptsMade < maxAttempts - 1) {
      throw execErr; // Permite retry BullMQ com backoff exponencial
    }

    await asActor(db, schedule.createdById, async (tx) => {
      await tx.publicationSchedule.update({
        where: { id: schedule.id },
        data: {
          status: "DEAD_LETTER",
          failureReason:
            execErr instanceof Error ? execErr.message : String(execErr),
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: schedule.organizationId,
          actorUserId: schedule.createdById,
          entityId: schedule.id,
          action: "schedule.dead_letter",
        },
      });
    });
    return { status: "dead_letter" };
  }

  // 7. Avaliação e transição de estado final
  await asActor(db, schedule.createdById, async (tx) => {
    if (execResult.allSuccess) {
      await tx.publicationSchedule.update({
        where: { id: schedule.id },
        data: { status: "PUBLISHED", failureReason: null },
      });
      await tx.auditLog.create({
        data: {
          organizationId: schedule.organizationId,
          actorUserId: schedule.createdById,
          entityId: schedule.id,
          action: "schedule.published",
        },
      });
    } else if (execResult.hasSuccess) {
      await tx.publicationSchedule.update({
        where: { id: schedule.id },
        data: {
          status: "PARTIALLY_PUBLISHED",
          failureReason:
            "Sucesso parcial: ao menos um destino foi publicado e outros falharam.",
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: schedule.organizationId,
          actorUserId: schedule.createdById,
          entityId: schedule.id,
          action: "schedule.partially_published",
        },
      });
    } else if (execResult.hasUncertain) {
      await tx.publicationSchedule.update({
        where: { id: schedule.id },
        data: {
          status: "REQUIRES_RECONCILIATION",
          failureReason:
            "Resultado remoto incerto em uma ou mais contas. Requer revisão manual.",
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: schedule.organizationId,
          actorUserId: schedule.createdById,
          entityId: schedule.id,
          action: "schedule.reconciliation_required",
        },
      });
    } else {
      // Todas as tentativas falharam
      const anyTransient = execResult.attempts.some(
        (a: { errorMessage?: string | null; errorCode?: string | null }) =>
          isTransientError(new Error(a.errorMessage || a.errorCode || "")),
      );

      const attemptsMade = job.attemptsMade ?? 0;
      const maxAttempts = job.opts?.attempts ?? 4;
      if (anyTransient && attemptsMade < maxAttempts - 1) {
        throw new Error("Falha transitória na publicação agendada.");
      }

      await tx.publicationSchedule.update({
        where: { id: schedule.id },
        data: {
          status: "DEAD_LETTER",
          failureReason:
            "Todas as tentativas de publicação falharam definitivamente.",
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: schedule.organizationId,
          actorUserId: schedule.createdById,
          entityId: schedule.id,
          action: "schedule.dead_letter",
        },
      });
    }
  });

  return {
    status: execResult.allSuccess
      ? "published"
      : execResult.hasSuccess
        ? "partially_published"
        : execResult.hasUncertain
          ? "requires_reconciliation"
          : "failed",
  };
}

export function createSchedulerWorker(
  db: PrismaClient,
  redis: Redis,
  config: Config,
  dependencies?: SchedulerWorkerDependencies,
): Worker<ScheduleJobData> {
  const concurrency = dependencies?.concurrency ?? 5;

  const worker = new Worker<ScheduleJobData>(
    SCHEDULE_QUEUE_NAME,
    async (job: Job<ScheduleJobData>) => {
      return processScheduleJob(job, db, redis, config, dependencies);
    },
    {
      connection: redis,
      concurrency,
      lockDuration: 60000,
      stalledInterval: 30000,
    },
  );

  worker.on("failed", async (job, err) => {
    console.error(
      JSON.stringify({
        event: "scheduler_job_failed",
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        error: err.message,
      }),
    );

    // Se as tentativas se esgotaram, garante estado persistente DEAD_LETTER
    if (job && job.attemptsMade >= (job.opts.attempts ?? 4)) {
      try {
        const { scheduleId, organizationId } = job.data;
        const schedule = await db.publicationSchedule.findUnique({
          where: { id: scheduleId },
        });
        if (
          schedule &&
          ![
            "PUBLISHED",
            "PARTIALLY_PUBLISHED",
            "CANCELLED",
            "DEAD_LETTER",
          ].includes(schedule.status)
        ) {
          await asActor(db, schedule.createdById, async (tx) => {
            await tx.publicationSchedule.update({
              where: { id: schedule.id },
              data: {
                status: "DEAD_LETTER",
                failureReason: `Tentativas esgotadas: ${err.message}`,
              },
            });
            await tx.auditLog.create({
              data: {
                organizationId,
                actorUserId: schedule.createdById,
                entityId: schedule.id,
                action: "schedule.dead_letter",
              },
            });
          });
        }
      } catch (dlErr) {
        console.error(
          JSON.stringify({
            event: "scheduler_dead_letter_persistence_error",
            error: dlErr instanceof Error ? dlErr.message : String(dlErr),
          }),
        );
      }
    }
  });

  return worker;
}
