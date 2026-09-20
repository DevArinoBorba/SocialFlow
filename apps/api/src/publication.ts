import type { Express, Request, Response } from "express";
import type { Redis } from "ioredis";
import { type Prisma } from "@socialflow/db";
import type { Config } from "@socialflow/config";
import {
  publishPostInput,
  publishPostResponse,
  resolvePublicationAttemptInput,
  resolvePublicationAttemptResponse,
  type PublicationAttemptDto,
  type Role,
} from "@socialflow/contracts";
import { MetaPublisherAdapter } from "./meta-publisher.js";
import {
  preparePublication,
  executePublication,
  PublicationError,
  LEASE_DURATION_MS,
  type PreparePublicationResult,
  type ExecutePublicationResult,
} from "./publication-service.js";

export { PublicationError, LEASE_DURATION_MS };

export type Scope = <T>(
  req: Request,
  org: string,
  fn: (
    tx: Prisma.TransactionClient,
    userId: string,
    admin: boolean,
  ) => Promise<T>,
) => Promise<T>;

export interface PublicationDependencies {
  publisher?: MetaPublisherAdapter;
  masterKey?: string | Buffer;
  onBeforePublish?: () => Promise<void>;
}

export function registerPublication(
  server: Express,
  scoped: Scope,
  redis: Redis,
  config: Config,
  dependencies?: PublicationDependencies,
) {
  const masterKey = dependencies?.masterKey ?? config.CREDENTIAL_MASTER_KEY;
  const publisher =
    dependencies?.publisher ??
    new MetaPublisherAdapter({
      graphBaseUrl: config.META_GRAPH_URL,
    });

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
            message:
              "Publicação concorrente em andamento ou já concluída para esta conta social.",
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
            event: "publication_request_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );

        res.status(503).json({
          message:
            "Não foi possível processar a publicação. Tente novamente mais tarde.",
        });
      }
    };
  }

  // --- MANUAL CONTROLLED PUBLISH ENDPOINT ---
  server.post(
    "/api/organizations/:org/clients/:clientId/posts/:postId/publish",
    handler(async (req, res) => {
      const parsed = publishPostInput.safeParse(req.body);
      if (!parsed.success) {
        const errorMsg =
          parsed.error.issues[0]?.message || "Dados de publicação inválidos.";
        throw new PublicationError(400, errorMsg);
      }

      const { socialAccountIds, mediaAssetId, idempotencyKey } = parsed.data;
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");
      const postId = param(req, "postId");

      // Idempotência HTTP no Redis para prevenir duplo clique e repetições imediatas
      const redisKey = `meta:publish:idempotency:${organizationId}:${clientId}:${postId}:${idempotencyKey}`;
      const acquired = await redis.set(
        redisKey,
        "IN_PROGRESS",
        "EX",
        86400,
        "NX",
      );

      if (!acquired) {
        const cached = await redis.get(redisKey);
        if (cached && cached !== "IN_PROGRESS") {
          try {
            const parsedCached = JSON.parse(cached);
            res.status(200).json(parsedCached);
            return;
          } catch {
            // falha de parse no cache, segue para rejeição
          }
        }
        throw new PublicationError(
          409,
          "Publicação já em processamento ou finalizada com esta chave de idempotência.",
        );
      }

      let prepResult: PreparePublicationResult;
      let authenticatedUserId = "";
      try {
        prepResult = await shortTx(
          req,
          organizationId,
          clientId,
          async (tx, userId) => {
            authenticatedUserId = userId;
            return preparePublication({
              tx,
              organizationId,
              clientId,
              postId,
              socialAccountIds,
              mediaAssetId,
              masterKey: masterKey!,
              allowSkippingPublished: false,
              auditCallback: (txScope, entityId, action) =>
                audit(txScope, req, userId, entityId, action),
            });
          },
        );
      } catch (dbErr) {
        await redis.del(redisKey);
        throw dbErr;
      }

      if ("uncertainAccount" in prepResult && prepResult.uncertainAccount) {
        await redis.del(redisKey);
        const acc = prepResult.uncertainAccount as {
          id: string;
          name: string | null;
        };
        throw new PublicationError(
          409,
          `Publicação anterior no Facebook foi interrompida com resultado incerto. Reconciliação manual necessária pelo administrador para a conta social ${acc.name || acc.id}.`,
        );
      }

      let execResult: ExecutePublicationResult;
      try {
        execResult = await executePublication({
          txRunner: (fn) =>
            shortTx(req, organizationId, clientId, (tx) => fn(tx)),
          auditCallback: (txScope, entityId, action) =>
            audit(txScope, req, authenticatedUserId, entityId, action),
          publisher,
          prepResult,
          organizationId,
          clientId,
          appUrl: config.APP_URL,
          redis,
          onBeforePublish: dependencies?.onBeforePublish,
        });
      } catch (execErr) {
        await redis.del(redisKey);
        throw execErr;
      }

      const finalResponse = publishPostResponse.parse({
        postId,
        success: execResult.allSuccess,
        attempts: execResult.attempts,
      });

      // Salva resultado concluído no Redis com TTL de 24h
      await redis.set(redisKey, JSON.stringify(finalResponse), "EX", 86400);

      res.status(200).json(finalResponse);
    }),
  );

  // --- MANUAL RECONCILIATION / RESOLUTION ENDPOINT (OWNER/ADMIN) ---
  server.post(
    "/api/organizations/:org/clients/:clientId/posts/:postId/attempts/:attemptId/resolve",
    handler(async (req, res) => {
      const parsed = resolvePublicationAttemptInput.safeParse(req.body);
      if (!parsed.success) {
        const errorMsg =
          parsed.error.issues[0]?.message || "Dados de resolução inválidos.";
        throw new PublicationError(400, errorMsg);
      }

      const { decision, remoteMediaId, remotePermalink, notes } = parsed.data;
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");
      const postId = param(req, "postId");
      const attemptId = param(req, "attemptId");

      const result = await accessScope(
        req,
        organizationId,
        clientId,
        ["OWNER", "ADMIN"],
        async (tx, userId) => {
          const attempt = await tx.publicationAttempt.findFirst({
            where: {
              id: attemptId,
              organizationId,
              clientId,
              postId,
            },
            include: {
              socialAccount: {
                select: { platform: true },
              },
            },
          });

          if (!attempt) {
            throw new PublicationError(
              404,
              "Tentativa de publicação não encontrada.",
            );
          }

          if (attempt.status === "PUBLISHED") {
            throw new PublicationError(
              400,
              "Tentativa já confirmada como publicada. Nenhuma ação necessária.",
            );
          }

          const now = new Date();
          const isLeaseActive =
            ["PENDING", "PROCESSING", "CONTAINER_CREATED"].includes(
              attempt.status,
            ) &&
            attempt.leaseExpiresAt &&
            attempt.leaseExpiresAt > now;

          if (isLeaseActive) {
            throw new PublicationError(
              409,
              "Tentativa ainda em execução ativa. Aguarde a expiração do lease antes de resolver.",
            );
          }

          if (decision === "CONFIRM_PUBLISHED") {
            // Verifica se já não existe outra tentativa publicada para a mesma conta
            const otherPublished = await tx.publicationAttempt.findFirst({
              where: {
                organizationId,
                clientId,
                postId,
                socialAccountId: attempt.socialAccountId,
                status: "PUBLISHED",
                id: { not: attempt.id },
              },
            });
            if (otherPublished) {
              throw new PublicationError(
                409,
                "Outra tentativa já está confirmada como publicada para esta conta social.",
              );
            }

            const updated = await tx.publicationAttempt.update({
              where: { id: attempt.id },
              data: {
                status: "PUBLISHED",
                remoteMediaId:
                  remoteMediaId || attempt.remoteMediaId || "MANUAL_CONFIRMED",
                remotePermalink: remotePermalink || attempt.remotePermalink,
                leaseExpiresAt: null,
                errorMessage: notes
                  ? `Reconciliado manualmente como publicado: ${notes}`
                  : (attempt.errorMessage ?? null),
              },
            });

            await audit(
              tx,
              req,
              userId,
              attempt.id,
              "post.reconciled_published",
            );

            return {
              ...updated,
              platform: attempt.socialAccount.platform,
            };
          }

          if (decision === "CONFIRM_FAILED") {
            const updated = await tx.publicationAttempt.update({
              where: { id: attempt.id },
              data: {
                status: "FAILED",
                errorCode: "MANUALLY_RECONCILED_FAILED",
                errorMessage: notes
                  ? `Reconciliado manualmente como falho: ${notes}`
                  : "Reconciliado manualmente como falho pelo administrador.",
                leaseExpiresAt: null,
              },
            });

            await audit(tx, req, userId, attempt.id, "post.reconciled_failed");

            return {
              ...updated,
              platform: attempt.socialAccount.platform,
            };
          }

          // DISMISS: Mantém o registro com anotação do admin sem alterar status conclusivo
          const updated = await tx.publicationAttempt.update({
            where: { id: attempt.id },
            data: {
              leaseExpiresAt: null,
              errorMessage: notes
                ? `Decisão mantida pelo administrador: ${notes}`
                : attempt.errorMessage,
            },
          });

          await audit(tx, req, userId, attempt.id, "post.reconciled_dismissed");

          return {
            ...updated,
            platform: attempt.socialAccount.platform,
          };
        },
      );

      const responseDto = resolvePublicationAttemptResponse.parse({
        success: true,
        attempt: {
          id: result.id,
          organizationId: result.organizationId,
          clientId: result.clientId,
          postId: result.postId,
          socialAccountId: result.socialAccountId,
          platform: result.platform as PublicationAttemptDto["platform"],
          status: result.status as PublicationAttemptDto["status"],
          creationContainerId: result.creationContainerId,
          remoteMediaId: result.remoteMediaId,
          remotePermalink: result.remotePermalink,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          attemptNumber: result.attemptNumber,
          executedAt: result.executedAt,
          leaseExpiresAt: result.leaseExpiresAt,
          createdAt: result.createdAt,
          updatedAt: result.updatedAt,
        },
      });

      res.status(200).json(responseDto);
    }),
  );
}
