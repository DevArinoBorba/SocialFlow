import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import {
  asSchedulerActor,
  type PrismaClient,
  type Prisma,
} from "@socialflow/db";
import type { Config } from "@socialflow/config";
import {
  SCHEDULE_QUEUE_NAME,
  type ScheduleJobData,
  createScheduleQueue,
  closeScheduleQueue,
} from "@socialflow/api/scheduler-queue.js";
import {
  preparePublication,
  executePublication,
  isTransientError,
} from "@socialflow/api/publication-service.js";
import { MetaPublisherAdapter } from "@socialflow/api/meta-publisher.js";

export const LATE_TOLERANCE_MS = 15 * 60 * 1000; // 15 minutos
export const SCHEDULE_LEASE_MS = 5 * 60 * 1000; // 5 minutos de lease

export interface SchedulerWorkerDependencies {
  publisher?: MetaPublisherAdapter;
  onBeforePublish?: () => Promise<void>;
  onBeforeAcquisition?: () => Promise<void>;
  onAfterAcquisition?: (acquired: boolean) => Promise<void>;
  onBeforeStateUpdate?: () => Promise<void>;
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
  const queue = createScheduleQueue(redis);

  try {
    // Descoberta segura com função SECURITY DEFINER mínima (sem bypass geral de RLS e sem dados de negócio)
    const candidateSchedules = await db.$queryRaw<
      Array<{
        scheduleId: string;
        organizationId: string;
        clientId: string;
        status: "SCHEDULED" | "ENQUEUED" | "PROCESSING";
        version: number;
        jobId: string;
        scheduledForUtc: Date;
        leaseExpiresAt: Date | null;
        updatedAt: Date;
      }>
    >`
      SELECT "scheduleId", "organizationId", "clientId", status, version, "jobId", "scheduledForUtc", "leaseExpiresAt", "updatedAt"
      FROM discover_reconcilable_schedules()
    `;

    // 1. Agendamentos em SCHEDULED ou ENQUEUED
    const pendingSchedules = candidateSchedules.filter((s) =>
      ["SCHEDULED", "ENQUEUED"].includes(s.status),
    );

    for (const schedule of pendingSchedules) {
      const scheduledUtc = new Date(schedule.scheduledForUtc);
      const delayMs = now.getTime() - scheduledUtc.getTime();

      // Política de atraso: atraso > 15 minutos vai para revisão manual sem publicar
      if (delayMs > LATE_TOLERANCE_MS) {
        await asSchedulerActor(
          db,
          {
            organizationId: schedule.organizationId,
            clientId: schedule.clientId,
          },
          async (tx) => {
            const updated = await tx.publicationSchedule.updateMany({
              where: {
                id: schedule.scheduleId,
                organizationId: schedule.organizationId,
                clientId: schedule.clientId,
                status: { in: ["SCHEDULED", "ENQUEUED"] },
              },
              data: {
                status: "REQUIRES_RECONCILIATION",
                failureReason:
                  "Atraso de execução superior a 15 minutos detectado na inicialização. Requer verificação manual.",
                leaseExpiresAt: null,
              },
            });
            if (updated.count === 1) {
              await tx.auditLog.create({
                data: {
                  organizationId: schedule.organizationId,
                  actorUserId: "system:scheduler",
                  entityId: schedule.scheduleId,
                  action: "schedule.reconciliation_required",
                },
              });
              flaggedLate++;
            }
          },
        );
        continue;
      }

      // Verifica se o job correspondente existe no BullMQ
      try {
        const job = await queue.getJob(schedule.jobId);
        if (!job) {
          // Dentro do escopo estrito do tenant, descobre o postId e reinjeta o job na fila
          await asSchedulerActor(
            db,
            {
              organizationId: schedule.organizationId,
              clientId: schedule.clientId,
            },
            async (tx) => {
              const fullSchedule = await tx.publicationSchedule.findUnique({
                where: { id: schedule.scheduleId },
                select: { postId: true, status: true },
              });
              if (!fullSchedule) return;

              const remainingDelay = Math.max(
                0,
                scheduledUtc.getTime() - Date.now(),
              );
              await queue.add(
                "publish-scheduled-post",
                {
                  scheduleId: schedule.scheduleId,
                  version: schedule.version,
                  organizationId: schedule.organizationId,
                  clientId: schedule.clientId,
                  postId: fullSchedule.postId,
                },
                {
                  jobId: schedule.jobId,
                  delay: remainingDelay,
                  removeOnComplete: 100,
                  removeOnFail: 500,
                },
              );

              if (fullSchedule.status !== "ENQUEUED") {
                await tx.publicationSchedule.updateMany({
                  where: { id: schedule.scheduleId, status: "SCHEDULED" },
                  data: { status: "ENQUEUED" },
                });
                await tx.auditLog.create({
                  data: {
                    organizationId: schedule.organizationId,
                    actorUserId: "system:scheduler",
                    entityId: schedule.scheduleId,
                    action: "schedule.enqueued",
                  },
                });
              }
              recoveredJobs++;
            },
          );
        }
      } catch (jobErr) {
        console.error(
          JSON.stringify({
            event: "reconciliation_job_check_error",
            scheduleId: schedule.scheduleId,
            error: jobErr instanceof Error ? jobErr.message : String(jobErr),
          }),
        );
      }
    }

    // 2. Agendamentos presos em PROCESSING com lease expirada
    const processingSchedules = candidateSchedules.filter(
      (s) => s.status === "PROCESSING",
    );

    for (const schedule of processingSchedules) {
      await asSchedulerActor(
        db,
        {
          organizationId: schedule.organizationId,
          clientId: schedule.clientId,
        },
        async (tx) => {
          const activeAttempts = await tx.publicationAttempt.findMany({
            where: {
              scheduleId: schedule.scheduleId,
              organizationId: schedule.organizationId,
              clientId: schedule.clientId,
            },
          });

          const relevantAttempts = activeAttempts.filter((a) =>
            ["PROCESSING", "CONTAINER_CREATED"].includes(a.status),
          );

          const hasActiveAttemptLease = relevantAttempts.some(
            (a) => a.leaseExpiresAt && new Date(a.leaseExpiresAt) > now,
          );

          const scheduleLease = schedule.leaseExpiresAt
            ? new Date(schedule.leaseExpiresAt)
            : null;
          const hasActiveScheduleLease = Boolean(
            scheduleLease && scheduleLease > now,
          );

          const updatedAtTime = new Date(schedule.updatedAt).getTime();
          if (
            !hasActiveAttemptLease &&
            !hasActiveScheduleLease &&
            (relevantAttempts.length > 0 ||
              now.getTime() - updatedAtTime > 5 * 60 * 1000 ||
              scheduleLease !== null)
          ) {
            // Lease expirada ou processo abandonado sem tentativas ativas. Envia para reconciliação manual
            const updated = await tx.publicationSchedule.updateMany({
              where: {
                id: schedule.scheduleId,
                organizationId: schedule.organizationId,
                clientId: schedule.clientId,
                status: "PROCESSING",
              },
              data: {
                status: "REQUIRES_RECONCILIATION",
                failureReason:
                  "Execução anterior abandonada com lease expirada. Requer reconciliação manual.",
                leaseExpiresAt: null,
              },
            });
            if (updated.count === 1) {
              await tx.auditLog.create({
                data: {
                  organizationId: schedule.organizationId,
                  actorUserId: "system:scheduler",
                  entityId: schedule.scheduleId,
                  action: "schedule.reconciliation_required",
                },
              });
              flaggedOrphan++;
            }
          }
        },
      );
    }
  } finally {
    await closeScheduleQueue(queue);
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

  // Hook determinístico pré-aquisição (para testes de corrida e barreiras)
  if (dependencies?.onBeforeAcquisition) {
    await dependencies.onBeforeAcquisition();
  }

  const executionToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + SCHEDULE_LEASE_MS);

  // Aquisição compare-and-set atômica via PostgreSQL sob identidade técnica restrita ao tenant
  let acquisitionResult: {
    acquired: boolean;
    status: string;
    schedule?: {
      id: string;
      organizationId: string;
      clientId: string;
      postId: string;
      targetAccountIds: string[];
      mediaAssetId: string | null;
      version: number;
    };
  };

  try {
    acquisitionResult = await asSchedulerActor(
      db,
      { organizationId, clientId },
      async (tx) => {
        const schedule = await tx.publicationSchedule.findFirst({
          where: { id: scheduleId, organizationId, clientId, postId },
        });

        if (!schedule) {
          return { acquired: false, status: "skipped_not_found" };
        }

        // 1. Verificação de versão obsoleta (ex: reprogramação recente)
        if (schedule.version !== version) {
          return { acquired: false, status: "skipped_obsolete_version" };
        }

        // 2. Verificação de status
        if (schedule.status === "CANCELLED") {
          return { acquired: false, status: "skipped_cancelled" };
        }

        if (
          [
            "PUBLISHED",
            "PARTIALLY_PUBLISHED",
            "DEAD_LETTER",
            "REQUIRES_RECONCILIATION",
          ].includes(schedule.status)
        ) {
          return { acquired: false, status: "skipped_already_terminal" };
        }

        // 3. Política de atraso de jobs: tolerância de até 15 minutos
        const now = new Date();
        const delayMs = now.getTime() - schedule.scheduledForUtc.getTime();
        if (delayMs > LATE_TOLERANCE_MS) {
          const lateUpdate = await tx.publicationSchedule.updateMany({
            where: {
              id: schedule.id,
              organizationId,
              clientId,
              postId,
              version,
              status: { in: ["SCHEDULED", "ENQUEUED"] },
            },
            data: {
              status: "REQUIRES_RECONCILIATION",
              failureReason: `Atraso de execução superior a 15 minutos (${Math.round(delayMs / 60000)} minutos de atraso). Requer revisão manual.`,
              leaseExpiresAt: null,
            },
          });
          if (lateUpdate.count === 1) {
            await tx.auditLog.create({
              data: {
                organizationId,
                actorUserId: "system:scheduler",
                entityId: schedule.id,
                action: "schedule.reconciliation_required",
              },
            });
            return { acquired: false, status: "requires_reconciliation_late" };
          }
          return { acquired: false, status: "skipped_not_acquired" };
        }

        // 4. Aquisição compare-and-set atômica no PostgreSQL
        const acquired = await tx.publicationSchedule.updateMany({
          where: {
            id: schedule.id,
            organizationId,
            clientId,
            postId,
            version,
            status: { in: ["SCHEDULED", "ENQUEUED"] },
          },
          data: {
            status: "PROCESSING",
            executionToken,
            leaseExpiresAt,
          },
        });

        if (acquired.count !== 1) {
          return { acquired: false, status: "skipped_not_acquired" };
        }

        // Gravado SOMENTE para o worker vencedor da aquisição
        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: "system:scheduler",
            entityId: schedule.id,
            action: "schedule.started",
          },
        });

        return {
          acquired: true,
          status: "acquired",
          schedule: {
            id: schedule.id,
            organizationId: schedule.organizationId,
            clientId: schedule.clientId,
            postId: schedule.postId,
            targetAccountIds: schedule.targetAccountIds,
            mediaAssetId: schedule.mediaAssetId,
            version: schedule.version,
          },
        };
      },
    );
  } catch (acqErr) {
    console.error(
      JSON.stringify({
        event: "scheduler_acquisition_error",
        scheduleId,
        error: acqErr instanceof Error ? acqErr.message : String(acqErr),
      }),
    );
    return { status: "skipped_acquisition_error" };
  }

  // Hook determinístico pós-aquisição (informa ao teste se este worker adquiriu a execução)
  if (dependencies?.onAfterAcquisition) {
    await dependencies.onAfterAcquisition(acquisitionResult.acquired);
  }

  if (!acquisitionResult.acquired || !acquisitionResult.schedule) {
    return { status: acquisitionResult.status };
  }

  const schedule = acquisitionResult.schedule;

  if (!config.CREDENTIAL_MASTER_KEY) {
    throw new Error("CREDENTIAL_MASTER_KEY não configurada no ambiente.");
  }

  // 5. Preparação dos alvos utilizando o serviço comum
  let prepResult;
  try {
    prepResult = await asSchedulerActor(
      db,
      {
        organizationId: schedule.organizationId,
        clientId: schedule.clientId,
      },
      async (tx) => {
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
                actorUserId: "system:scheduler",
                entityId,
                action,
              },
            }),
        });
      },
    );
  } catch (prepErr) {
    // Falha permanente na preparação (ex: post rejeitado, conta excluída)
    await asSchedulerActor(
      db,
      {
        organizationId: schedule.organizationId,
        clientId: schedule.clientId,
      },
      async (tx) => {
        const updated = await tx.publicationSchedule.updateMany({
          where: {
            id: schedule.id,
            organizationId: schedule.organizationId,
            clientId: schedule.clientId,
            version,
            executionToken,
            status: "PROCESSING",
          },
          data: {
            status: "FAILED",
            failureReason:
              prepErr instanceof Error ? prepErr.message : String(prepErr),
            leaseExpiresAt: null,
          },
        });
        if (updated.count === 1) {
          await tx.auditLog.create({
            data: {
              organizationId: schedule.organizationId,
              actorUserId: "system:scheduler",
              entityId: schedule.id,
              action: "schedule.failed",
            },
          });
        }
      },
    );
    return { status: "failed_preparation" };
  }

  if ("uncertainAccount" in prepResult && prepResult.uncertainAccount) {
    await asSchedulerActor(
      db,
      {
        organizationId: schedule.organizationId,
        clientId: schedule.clientId,
      },
      async (tx) => {
        const updated = await tx.publicationSchedule.updateMany({
          where: {
            id: schedule.id,
            organizationId: schedule.organizationId,
            clientId: schedule.clientId,
            version,
            executionToken,
            status: "PROCESSING",
          },
          data: {
            status: "REQUIRES_RECONCILIATION",
            failureReason:
              "Conta com resultado remoto incerto anterior aguardando reconciliação manual.",
            leaseExpiresAt: null,
          },
        });
        if (updated.count === 1) {
          await tx.auditLog.create({
            data: {
              organizationId: schedule.organizationId,
              actorUserId: "system:scheduler",
              entityId: schedule.id,
              action: "schedule.reconciliation_required",
            },
          });
        }
      },
    );
    return { status: "requires_reconciliation_uncertain" };
  }

  // 6. Execução das publicações com MetaPublisherAdapter fora de transação
  let execResult;
  try {
    execResult = await executePublication({
      txRunner: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
        asSchedulerActor(
          db,
          {
            organizationId: schedule.organizationId,
            clientId: schedule.clientId,
          },
          fn,
        ),
      auditCallback: (
        txScope: Prisma.TransactionClient,
        entityId: string,
        action: string,
      ) =>
        txScope.auditLog.create({
          data: {
            organizationId: schedule.organizationId,
            actorUserId: "system:scheduler",
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

    await asSchedulerActor(
      db,
      {
        organizationId: schedule.organizationId,
        clientId: schedule.clientId,
      },
      async (tx) => {
        const updated = await tx.publicationSchedule.updateMany({
          where: {
            id: schedule.id,
            organizationId: schedule.organizationId,
            clientId: schedule.clientId,
            version,
            executionToken,
            status: "PROCESSING",
          },
          data: {
            status: "DEAD_LETTER",
            failureReason:
              execErr instanceof Error ? execErr.message : String(execErr),
            leaseExpiresAt: null,
          },
        });
        if (updated.count === 1) {
          await tx.auditLog.create({
            data: {
              organizationId: schedule.organizationId,
              actorUserId: "system:scheduler",
              entityId: schedule.id,
              action: "schedule.dead_letter",
            },
          });
        }
      },
    );
    return { status: "dead_letter" };
  }

  // Hook determinístico pré-atualização de estado final
  if (dependencies?.onBeforeStateUpdate) {
    await dependencies.onBeforeStateUpdate();
  }

  // 7. Avaliação e transição de estado final exigindo a identidade de execução (executionToken)
  let terminalStatus:
    | "PUBLISHED"
    | "PARTIALLY_PUBLISHED"
    | "REQUIRES_RECONCILIATION"
    | "DEAD_LETTER";
  let terminalReason: string | null = null;
  let terminalAuditAction: string;

  if (execResult.allSuccess) {
    terminalStatus = "PUBLISHED";
    terminalReason = null;
    terminalAuditAction = "schedule.published";
  } else if (execResult.hasSuccess) {
    terminalStatus = "PARTIALLY_PUBLISHED";
    terminalReason =
      "Sucesso parcial: ao menos um destino foi publicado e outros falharam.";
    terminalAuditAction = "schedule.partially_published";
  } else if (execResult.hasUncertain) {
    terminalStatus = "REQUIRES_RECONCILIATION";
    terminalReason =
      "Resultado remoto incerto em uma ou mais contas. Requer revisão manual.";
    terminalAuditAction = "schedule.reconciliation_required";
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

    terminalStatus = "DEAD_LETTER";
    terminalReason =
      "Todas as tentativas de publicação falharam definitivamente.";
    terminalAuditAction = "schedule.dead_letter";
  }

  let finalUpdated = false;
  await asSchedulerActor(
    db,
    {
      organizationId: schedule.organizationId,
      clientId: schedule.clientId,
    },
    async (tx) => {
      const updated = await tx.publicationSchedule.updateMany({
        where: {
          id: schedule.id,
          organizationId: schedule.organizationId,
          clientId: schedule.clientId,
          version,
          executionToken,
          status: "PROCESSING",
        },
        data: {
          status: terminalStatus,
          failureReason: terminalReason,
          leaseExpiresAt: null,
        },
      });

      if (updated.count === 1) {
        finalUpdated = true;
        await tx.auditLog.create({
          data: {
            organizationId: schedule.organizationId,
            actorUserId: "system:scheduler",
            entityId: schedule.id,
            action: terminalAuditAction,
          },
        });
      }
    },
  );

  if (!finalUpdated) {
    return { status: "skipped_lost_execution_identity" };
  }

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
        const { scheduleId, organizationId, clientId, version } = job.data;
        await asSchedulerActor(db, { organizationId, clientId }, async (tx) => {
          const updated = await tx.publicationSchedule.updateMany({
            where: {
              id: scheduleId,
              organizationId,
              clientId,
              version,
              status: "PROCESSING",
            },
            data: {
              status: "DEAD_LETTER",
              failureReason: `Tentativas esgotadas: ${err.message}`,
              leaseExpiresAt: null,
            },
          });
          if (updated.count === 1) {
            await tx.auditLog.create({
              data: {
                organizationId,
                actorUserId: "system:scheduler",
                entityId: scheduleId,
                action: "schedule.dead_letter",
              },
            });
          }
        });
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
