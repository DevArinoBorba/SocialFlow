import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { Redis } from "ioredis";
import { type Prisma } from "@socialflow/db";
import {
  createScheduleInput,
  rescheduleInput,
  cancelScheduleInput,
  parseLocalDateTimeToUtc,
  type Role,
} from "@socialflow/contracts";
import { PublicationError } from "./publication-service.js";
import { getScheduleQueue, getScheduleJobId } from "./scheduler-queue.js";

export type Scope = <T>(
  req: Request,
  org: string,
  fn: (
    tx: Prisma.TransactionClient,
    userId: string,
    admin: boolean,
  ) => Promise<T>,
) => Promise<T>;

export function registerScheduler(
  server: Express,
  scoped: Scope,
  redis: Redis,
) {
  const param = (req: Request, name: string): string => {
    const val = req.params[name];
    if (val !== undefined) return String(val);
    return "";
  };

  async function accessScope<T>(
    req: Request,
    org: string,
    clientId: string,
    allowedRoles: Role[],
    fn: (
      tx: Prisma.TransactionClient,
      userId: string,
      role: Role,
      admin: boolean,
    ) => Promise<T>,
  ) {
    return scoped(req, org, async (tx, userId, admin) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, organizationId: org, active: true },
      });
      if (!client) throw new PublicationError(404, "Cliente não encontrado.");

      let effectiveRole: Role = admin ? "ADMIN" : "CLIENT_VIEWER";
      if (!admin) {
        const clientMembership = await tx.membership.findFirst({
          where: {
            userId,
            organizationId: org,
            clientId,
            active: true,
          },
        });
        if (!clientMembership) {
          throw new PublicationError(404, "Cliente não encontrado.");
        }
        effectiveRole = clientMembership.role;
      } else {
        const orgMembership = await tx.membership.findFirst({
          where: {
            userId,
            organizationId: org,
            clientId: null,
            active: true,
          },
        });
        if (orgMembership) {
          effectiveRole = orgMembership.role;
        }
      }

      if (!allowedRoles.includes(effectiveRole)) {
        throw new PublicationError(
          403,
          "Acesso não autorizado para o seu perfil.",
        );
      }

      return fn(tx, userId, effectiveRole, admin);
    });
  }

  async function shortTx<T>(
    req: Request,
    organizationId: string,
    clientId: string,
    fn: (tx: Prisma.TransactionClient, userId: string) => Promise<T>,
  ): Promise<T> {
    return accessScope(
      req,
      organizationId,
      clientId,
      ["OWNER", "ADMIN", "APPROVER"],
      async (tx, userId) => fn(tx, userId),
    );
  }

  const audit = (
    tx: Prisma.TransactionClient,
    req: Request,
    userId: string,
    entityId: string,
    action: string,
  ) =>
    tx.auditLog.create({
      data: {
        organizationId: param(req, "org"),
        actorUserId: userId,
        entityId,
        action,
      },
    });

  function handler(fn: (req: Request, res: Response) => Promise<unknown>) {
    return async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (error: unknown) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code: string }).code === "P2002"
        ) {
          res.status(409).json({
            message: "Conflito de agendamento concorrente.",
          });
          return;
        }

        if (error instanceof PublicationError) {
          res.status(error.status).json({
            message: error.message,
          });
          return;
        }

        console.error(
          JSON.stringify({
            event: "scheduler_request_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );

        res.status(500).json({
          message:
            "Não foi possível processar o agendamento. Tente novamente mais tarde.",
        });
      }
    };
  }

  // --- POST /schedules: Criar Agendamento ---
  server.post(
    "/api/organizations/:org/clients/:clientId/posts/:postId/schedules",
    handler(async (req, res) => {
      const parsed = createScheduleInput.safeParse(req.body);
      if (!parsed.success) {
        const errorMsg =
          parsed.error.issues[0]?.message || "Dados de agendamento inválidos.";
        throw new PublicationError(400, errorMsg);
      }

      const {
        targetAccountIds,
        mediaAssetId,
        scheduledTimezone,
        scheduledLocalTime,
      } = parsed.data;
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");
      const postId = param(req, "postId");

      let scheduledForUtc: Date;
      try {
        scheduledForUtc = parseLocalDateTimeToUtc(
          scheduledLocalTime,
          scheduledTimezone,
        );
      } catch (tzErr) {
        throw new PublicationError(
          400,
          tzErr instanceof Error
            ? tzErr.message
            : "Fuso horário ou data inválida.",
        );
      }

      if (scheduledForUtc.getTime() <= Date.now()) {
        throw new PublicationError(
          400,
          "O horário agendado deve ser posterior ao momento atual.",
        );
      }

      const schedule = await shortTx(
        req,
        organizationId,
        clientId,
        async (tx, userId) => {
          const post = await tx.post.findFirst({
            where: { id: postId, organizationId, clientId },
          });
          if (!post) {
            throw new PublicationError(404, "Publicação não encontrada.");
          }
          if (post.status !== "APPROVED") {
            throw new PublicationError(
              422,
              "Apenas publicações aprovadas podem ser agendadas.",
            );
          }

          const accounts = await tx.socialAccount.findMany({
            where: {
              id: { in: targetAccountIds },
              organizationId,
              clientId,
              status: "ACTIVE",
            },
          });

          if (accounts.length !== targetAccountIds.length) {
            throw new PublicationError(
              400,
              "Uma ou mais contas sociais não pertencem a este cliente ou estão inativas.",
            );
          }

          const hasInstagram = accounts.some(
            (acc) => acc.platform === "INSTAGRAM_BUSINESS",
          );
          if (hasInstagram && !mediaAssetId) {
            throw new PublicationError(
              400,
              "Publicações no Instagram exigem a seleção de uma imagem.",
            );
          }

          if (mediaAssetId) {
            const media = await tx.mediaAsset.findFirst({
              where: {
                id: mediaAssetId,
                organizationId,
                clientId,
                status: "ready",
                archived: false,
              },
            });
            if (!media) {
              throw new PublicationError(
                404,
                "Imagem selecionada não encontrada ou não está disponível.",
              );
            }
          }

          const existingPublished = await tx.publicationAttempt.findFirst({
            where: {
              organizationId,
              clientId,
              postId,
              socialAccountId: { in: targetAccountIds },
              status: "PUBLISHED",
            },
          });
          if (existingPublished) {
            throw new PublicationError(
              409,
              "Uma ou mais contas sociais selecionadas já publicaram este post.",
            );
          }

          const scheduleId = randomUUID();
          const version = 1;
          const jobId = getScheduleJobId(scheduleId, version);

          const created = await tx.publicationSchedule.create({
            data: {
              id: scheduleId,
              organizationId,
              clientId,
              postId,
              targetAccountIds,
              mediaAssetId: mediaAssetId ?? null,
              scheduledTimezone,
              scheduledLocalTime,
              scheduledForUtc,
              status: "SCHEDULED",
              version,
              jobId,
              createdById: userId,
            },
          });

          await audit(tx, req, userId, created.id, "schedule.created");
          return created;
        },
      );

      // Enfileira job BullMQ com atraso (delay) baseado no instante UTC
      const delay = Math.max(0, scheduledForUtc.getTime() - Date.now());
      const queue = getScheduleQueue(redis);
      await queue.add(
        "publish-scheduled-post",
        {
          scheduleId: schedule.id,
          version: schedule.version,
          organizationId,
          clientId,
          postId,
        },
        {
          jobId: schedule.jobId,
          delay,
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      );

      // Transiciona para ENQUEUED e grava auditoria
      const enqueued = await shortTx(
        req,
        organizationId,
        clientId,
        async (tx, userId) => {
          const updated = await tx.publicationSchedule.update({
            where: { id: schedule.id },
            data: { status: "ENQUEUED" },
          });
          await audit(tx, req, userId, schedule.id, "schedule.enqueued");
          return updated;
        },
      );

      res.status(201).json(enqueued);
    }),
  );

  // --- POST /schedules/:scheduleId/reschedule: Reprogramar Agendamento ---
  server.post(
    "/api/organizations/:org/clients/:clientId/posts/:postId/schedules/:scheduleId/reschedule",
    handler(async (req, res) => {
      const parsed = rescheduleInput.safeParse(req.body);
      if (!parsed.success) {
        const errorMsg =
          parsed.error.issues[0]?.message ||
          "Dados de reprogramação inválidos.";
        throw new PublicationError(400, errorMsg);
      }

      const { scheduledTimezone, scheduledLocalTime } = parsed.data;
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");
      const postId = param(req, "postId");
      const scheduleId = param(req, "scheduleId");

      let scheduledForUtc: Date;
      try {
        scheduledForUtc = parseLocalDateTimeToUtc(
          scheduledLocalTime,
          scheduledTimezone,
        );
      } catch (tzErr) {
        throw new PublicationError(
          400,
          tzErr instanceof Error
            ? tzErr.message
            : "Fuso horário ou data inválida.",
        );
      }

      if (scheduledForUtc.getTime() <= Date.now()) {
        throw new PublicationError(
          400,
          "O novo horário agendado deve ser posterior ao momento atual.",
        );
      }

      const { oldJobId, updatedSchedule } = await shortTx(
        req,
        organizationId,
        clientId,
        async (tx, userId) => {
          const schedule = await tx.publicationSchedule.findFirst({
            where: { id: scheduleId, organizationId, clientId, postId },
          });
          if (!schedule) {
            throw new PublicationError(404, "Agendamento não encontrado.");
          }

          if (schedule.status === "PROCESSING") {
            throw new PublicationError(
              409,
              "A publicação agendada já está em processamento e não pode ser reprogramada.",
            );
          }

          if (
            [
              "PUBLISHED",
              "PARTIALLY_PUBLISHED",
              "CANCELLED",
              "DEAD_LETTER",
            ].includes(schedule.status)
          ) {
            throw new PublicationError(
              409,
              `Agendamento em estado ${schedule.status} não pode ser reprogramado.`,
            );
          }

          const nextVersion = schedule.version + 1;
          const nextJobId = getScheduleJobId(schedule.id, nextVersion);

          const updated = await tx.publicationSchedule.update({
            where: { id: schedule.id },
            data: {
              scheduledTimezone,
              scheduledLocalTime,
              scheduledForUtc,
              version: nextVersion,
              jobId: nextJobId,
              status: "SCHEDULED",
            },
          });

          await audit(tx, req, userId, schedule.id, "schedule.rescheduled");
          return { oldJobId: schedule.jobId, updatedSchedule: updated };
        },
      );

      // Remove job antigo determinístico do BullMQ
      const queue = getScheduleQueue(redis);
      try {
        const oldJob = await queue.getJob(oldJobId);
        if (oldJob) {
          await oldJob.remove();
        }
      } catch {
        // ignora se já foi concluído ou removido
      }

      // Adiciona novo delayed job com a nova versão
      const delay = Math.max(0, scheduledForUtc.getTime() - Date.now());
      await queue.add(
        "publish-scheduled-post",
        {
          scheduleId: updatedSchedule.id,
          version: updatedSchedule.version,
          organizationId,
          clientId,
          postId,
        },
        {
          jobId: updatedSchedule.jobId,
          delay,
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      );

      // Transiciona para ENQUEUED
      const finalSchedule = await shortTx(
        req,
        organizationId,
        clientId,
        async (tx, userId) => {
          const updated = await tx.publicationSchedule.update({
            where: { id: updatedSchedule.id },
            data: { status: "ENQUEUED" },
          });
          await audit(tx, req, userId, updated.id, "schedule.enqueued");
          return updated;
        },
      );

      res.status(200).json(finalSchedule);
    }),
  );

  // --- POST /schedules/:scheduleId/cancel: Cancelar Agendamento ---
  server.post(
    "/api/organizations/:org/clients/:clientId/posts/:postId/schedules/:scheduleId/cancel",
    handler(async (req, res) => {
      const parsed = cancelScheduleInput.safeParse(req.body);
      const reason = parsed.success ? parsed.data.reason : null;

      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");
      const postId = param(req, "postId");
      const scheduleId = param(req, "scheduleId");

      const { schedule, cancelled } = await shortTx(
        req,
        organizationId,
        clientId,
        async (tx, userId) => {
          const existing = await tx.publicationSchedule.findFirst({
            where: { id: scheduleId, organizationId, clientId, postId },
          });

          if (!existing) {
            throw new PublicationError(404, "Agendamento não encontrado.");
          }

          if (existing.status === "PROCESSING") {
            throw new PublicationError(
              409,
              "A publicação agendada já está em processamento e não pode ser cancelada.",
            );
          }

          if (["PUBLISHED", "CANCELLED"].includes(existing.status)) {
            throw new PublicationError(
              409,
              `Agendamento já se encontra em estado ${existing.status}.`,
            );
          }

          const updated = await tx.publicationSchedule.update({
            where: { id: existing.id },
            data: {
              status: "CANCELLED",
              cancellationReason: reason || "Cancelado pelo usuário",
            },
          });

          await audit(tx, req, userId, existing.id, "schedule.cancelled");
          return { schedule: existing, cancelled: updated };
        },
      );

      // Remove job do BullMQ
      const queue = getScheduleQueue(redis);
      try {
        const job = await queue.getJob(schedule.jobId);
        if (job) {
          await job.remove();
        }
      } catch {
        // Ignora caso o job já não exista mais
      }

      res.status(200).json(cancelled);
    }),
  );

  // --- GET /schedules: Listar Agendamentos de um Post ---
  server.get(
    "/api/organizations/:org/clients/:clientId/posts/:postId/schedules",
    handler(async (req, res) => {
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");
      const postId = param(req, "postId");

      const schedules = await accessScope(
        req,
        organizationId,
        clientId,
        ["OWNER", "ADMIN", "APPROVER", "EDITOR", "CLIENT_VIEWER"],
        async (tx) => {
          return tx.publicationSchedule.findMany({
            where: { organizationId, clientId, postId },
            orderBy: { createdAt: "desc" },
            include: {
              publicationAttempts: true,
            },
          });
        },
      );

      res.status(200).json({ schedules });
    }),
  );
}
