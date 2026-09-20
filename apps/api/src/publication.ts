import type { Express, Request, Response } from "express";
import type { Redis } from "ioredis";
import {
  createCredentialCrypto,
  type Prisma,
  type CredentialContext,
} from "@socialflow/db";
import type { Config } from "@socialflow/config";
import {
  publishPostInput,
  publishPostResponse,
  resolvePublicationAttemptInput,
  resolvePublicationAttemptResponse,
  type PublicationAttemptDto,
  type Role,
} from "@socialflow/contracts";
import {
  MetaPublisherAdapter,
  MetaAuthError,
  isTimeoutError,
} from "./meta-publisher.js";
import { createPublicMediaTicket } from "./media-ticket.js";

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

export const LEASE_DURATION_MS = 3 * 60 * 1000; // 3 minutos

export class PublicationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "PublicationError";
  }
}

interface TargetPrep {
  account: {
    id: string;
    name: string | null;
    platform: "FACEBOOK_PAGE" | "INSTAGRAM_BUSINESS";
    platformAccountId: string;
    status: string;
  };
  attempt: {
    id: string;
    organizationId: string;
    clientId: string;
    postId: string;
    socialAccountId: string;
    status: string;
    creationContainerId: string | null;
    remoteMediaId: string | null;
    remotePermalink: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    attemptNumber: number;
    executedAt: Date;
    leaseExpiresAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  accessToken?: string;
  previousContainerId?: string | null;
  skippedDueToError: boolean;
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

      let prepResult: {
        post: {
          id: string;
          caption: string;
          hashtags: string | null;
        };
        mediaAsset: {
          id: string;
          storageKey: string;
          mimeType: string | null;
          byteSize: number | null;
          sha256: string | null;
        } | null;
        targets: TargetPrep[];
        uncertainAccount?: {
          id: string;
          name: string | null;
        } | null;
      };

      try {
        // ETAPA 1: TRANSAÇÃO CURTA (Autorização, Validação e Reserva de Tentativas no PostgreSQL)
        // Fecha imediatamente antes de qualquer chamada externa à Meta.
        prepResult = await shortTx(
          req,
          organizationId,
          clientId,
          async (tx, userId) => {
            const post = await tx.post.findFirst({
              where: {
                id: postId,
                organizationId,
                clientId,
              },
            });

            if (!post) {
              throw new PublicationError(404, "Publicação não encontrada.");
            }

            if (post.status !== "APPROVED") {
              throw new PublicationError(
                422,
                "Apenas publicações com status APROVADO podem ser publicadas.",
              );
            }

            const accounts = await tx.socialAccount.findMany({
              where: {
                id: { in: socialAccountIds },
                organizationId,
                clientId,
              },
              include: { credential: true },
            });

            if (accounts.length !== socialAccountIds.length) {
              throw new PublicationError(
                400,
                "Uma ou mais contas sociais selecionadas não pertencem a este cliente.",
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

            let mediaAsset: {
              id: string;
              storageKey: string;
              mimeType: string | null;
              byteSize: number | null;
              sha256: string | null;
            } | null = null;

            if (mediaAssetId) {
              mediaAsset = await tx.mediaAsset.findFirst({
                where: {
                  id: mediaAssetId,
                  organizationId,
                  clientId,
                  status: "ready",
                  archived: false,
                },
              });

              if (!mediaAsset) {
                throw new PublicationError(
                  404,
                  "Imagem selecionada não encontrada ou não está disponível.",
                );
              }
            }

            if (!masterKey) {
              throw new PublicationError(
                500,
                "Chave mestra de credenciais não configurada.",
              );
            }
            const credentialCrypto = createCredentialCrypto(masterKey);

            // Consulta todas as tentativas existentes para as contas selecionadas
            const existingAttempts = await tx.publicationAttempt.findMany({
              where: {
                organizationId,
                clientId,
                postId,
                socialAccountId: { in: socialAccountIds },
              },
              orderBy: { attemptNumber: "desc" },
            });

            // ETAPA 1.A: ANÁLISE E VALIDAÇÃO GLOBAL DE TODAS AS CONTAS SELECIONADAS
            // Valida PUBLISHED, UNCERTAIN, lease ativa/expirada e credenciais ANTES de qualquer gravação.
            type AccountPlan =
              | {
                  action: "RESUME_INSTAGRAM";
                  account: (typeof accounts)[number];
                  activeAttemptId: string;
                  previousContainerId: string | null;
                  attemptNumber: number;
                  accessToken: string;
                }
              | {
                  action: "CREATE_PROCESSING";
                  account: (typeof accounts)[number];
                  previousContainerId: string | null;
                  attemptNumber: number;
                  accessToken: string;
                }
              | {
                  action: "RECORD_FAILED";
                  account: (typeof accounts)[number];
                  attemptNumber: number;
                  errorCode: string;
                  errorMessage: string;
                };

            const plans: AccountPlan[] = [];
            let facebookExpiredAccount: {
              id: string;
              name: string | null;
            } | null = null;
            const facebookExpiredAttemptIds: string[] = [];

            for (const account of accounts) {
              const accountAttempts = existingAttempts.filter(
                (a) => a.socialAccountId === account.id,
              );

              // 1. Bloqueio definitivo se já houver tentativa PUBLISHED
              const published = accountAttempts.find(
                (a) => a.status === "PUBLISHED",
              );
              if (published) {
                throw new PublicationError(
                  409,
                  `Post já publicado com sucesso para a conta social ${account.name || account.id}.`,
                );
              }

              // 2. Bloqueio estrito se houver tentativa em andamento ou incerta
              const active = accountAttempts.find((a) =>
                [
                  "PENDING",
                  "PROCESSING",
                  "CONTAINER_CREATED",
                  "UNCERTAIN",
                ].includes(a.status),
              );

              let previousContainerId: string | null = null;
              let isInstagramResumption = false;

              if (active) {
                if (active.status === "UNCERTAIN") {
                  throw new PublicationError(
                    409,
                    `Publicação em estado incerto aguardando reconciliação manual pelo administrador para a conta social ${account.name || account.id}.`,
                  );
                }

                const now = new Date();
                const isLeaseActive =
                  active.leaseExpiresAt && active.leaseExpiresAt > now;

                if (isLeaseActive) {
                  throw new PublicationError(
                    409,
                    `Publicação em andamento para a conta social ${account.name || account.id}.`,
                  );
                }

                // Lease expirado: processo anterior foi abandonado ou interrompido
                if (account.platform === "INSTAGRAM_BUSINESS") {
                  isInstagramResumption = true;
                  previousContainerId = active.creationContainerId;
                } else {
                  // Facebook: sem ID remoto de confirmação, não é seguro republicar automaticamente.
                  // Coleta para transicionar para UNCERTAIN e abortar a reserva do lote.
                  facebookExpiredAttemptIds.push(active.id);
                  if (!facebookExpiredAccount) {
                    facebookExpiredAccount = {
                      id: account.id,
                      name: account.name,
                    };
                  }
                }
              }

              const lastAttempt = accountAttempts[0];
              const attemptNumber = (lastAttempt?.attemptNumber ?? 0) + 1;
              if (!previousContainerId) {
                previousContainerId = lastAttempt?.creationContainerId ?? null;
              }

              // Se já detectamos bloqueio no Facebook, não precisamos descriptografar credenciais
              if (facebookExpiredAccount) {
                continue;
              }

              // Valida status da conta e credencial
              if (account.status !== "ACTIVE" || !account.credential) {
                plans.push({
                  action: "RECORD_FAILED",
                  account,
                  attemptNumber,
                  errorCode: "ACCOUNT_INACTIVE",
                  errorMessage:
                    account.status === "ACTIVE"
                      ? "Credencial OAuth ausente. Reconecte a conta."
                      : `Conta social em estado ${account.status}. Reconexão necessária.`,
                });
                continue;
              }

              // Decripta token OAuth em memória
              let accessToken: string;
              try {
                const cred = account.credential;
                const credContext: CredentialContext = {
                  organizationId,
                  clientId,
                  platformAccountId: account.platformAccountId,
                  keyVersion: cred.keyVersion,
                };
                accessToken = credentialCrypto.decrypt(
                  {
                    encryptedAccessToken: cred.encryptedAccessToken,
                    iv: cred.iv,
                    authTag: cred.authTag,
                    keyVersion: cred.keyVersion,
                  },
                  credContext,
                );
              } catch {
                plans.push({
                  action: "RECORD_FAILED",
                  account,
                  attemptNumber,
                  errorCode: "CRYPTO_DECRYPT_FAILED",
                  errorMessage:
                    "Falha ao descriptografar token da conta social.",
                });
                continue;
              }

              if (isInstagramResumption && active) {
                plans.push({
                  action: "RESUME_INSTAGRAM",
                  account,
                  activeAttemptId: active.id,
                  previousContainerId,
                  attemptNumber,
                  accessToken,
                });
              } else {
                plans.push({
                  action: "CREATE_PROCESSING",
                  account,
                  previousContainerId,
                  attemptNumber,
                  accessToken,
                });
              }
            }

            // SE QUALQUER CONTA FACEBOOK TIVER LEASE EXPIRADA:
            // Transiciona essas tentativas para UNCERTAIN e aborta o lote.
            // NENHUMA tentativa PROCESSING é criada para as demais contas.
            if (facebookExpiredAccount) {
              for (const attemptId of facebookExpiredAttemptIds) {
                await tx.publicationAttempt.update({
                  where: { id: attemptId },
                  data: {
                    status: "UNCERTAIN",
                    errorCode: "LEASE_EXPIRED_UNCERTAIN",
                    errorMessage:
                      "Execução anterior no Facebook expirou antes da confirmação. Reconciliação manual necessária pelo administrador.",
                    leaseExpiresAt: null,
                  },
                });
                await audit(
                  tx,
                  req,
                  userId,
                  attemptId,
                  "post.publish_uncertain",
                );
              }

              return {
                uncertainAccount: facebookExpiredAccount,
                post: null as never,
                mediaAsset: null as never,
                targets: [] as never,
              };
            }

            // ETAPA 1.B: SOMENTE APÓS A ANÁLISE GLOBAL CONFIRMAR QUE O LOTE PODE PROSSEGUIR:
            // Atualiza tentativas abandonadas, cria reservas PROCESSING e grava auditorias.
            const targets: TargetPrep[] = [];

            for (const plan of plans) {
              if (plan.action === "RECORD_FAILED") {
                const failedAttempt = await tx.publicationAttempt.create({
                  data: {
                    organizationId,
                    clientId,
                    postId,
                    socialAccountId: plan.account.id,
                    status: "FAILED",
                    attemptNumber: plan.attemptNumber,
                    executedAt: new Date(),
                    errorCode: plan.errorCode,
                    errorMessage: plan.errorMessage,
                  },
                });
                await audit(
                  tx,
                  req,
                  userId,
                  failedAttempt.id,
                  "post.publish_failed",
                );
                targets.push({
                  account: {
                    id: plan.account.id,
                    name: plan.account.name,
                    platform: plan.account.platform,
                    platformAccountId: plan.account.platformAccountId,
                    status: plan.account.status,
                  },
                  attempt: failedAttempt,
                  skippedDueToError: true,
                });
              } else if (plan.action === "RESUME_INSTAGRAM") {
                await tx.publicationAttempt.update({
                  where: { id: plan.activeAttemptId },
                  data: {
                    status: "FAILED",
                    errorCode: "ABANDONED_LEASE_EXPIRED",
                    errorMessage: plan.previousContainerId
                      ? "Execução anterior expirou. Tentativa retomada automaticamente aproveitando container existente."
                      : "Execução anterior expirou antes da criação do container. Tentativa retomada.",
                    leaseExpiresAt: null,
                  },
                });
                await audit(
                  tx,
                  req,
                  userId,
                  plan.activeAttemptId,
                  "post.lease_expired",
                );

                const reservedAttempt = await tx.publicationAttempt.create({
                  data: {
                    organizationId,
                    clientId,
                    postId,
                    socialAccountId: plan.account.id,
                    status: "PROCESSING",
                    attemptNumber: plan.attemptNumber,
                    creationContainerId: plan.previousContainerId,
                    leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
                    executedAt: new Date(),
                  },
                });

                targets.push({
                  account: {
                    id: plan.account.id,
                    name: plan.account.name,
                    platform: plan.account.platform,
                    platformAccountId: plan.account.platformAccountId,
                    status: plan.account.status,
                  },
                  attempt: reservedAttempt,
                  accessToken: plan.accessToken,
                  previousContainerId: plan.previousContainerId,
                  skippedDueToError: false,
                });
              } else if (plan.action === "CREATE_PROCESSING") {
                const reservedAttempt = await tx.publicationAttempt.create({
                  data: {
                    organizationId,
                    clientId,
                    postId,
                    socialAccountId: plan.account.id,
                    status: "PROCESSING",
                    attemptNumber: plan.attemptNumber,
                    creationContainerId: plan.previousContainerId,
                    leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
                    executedAt: new Date(),
                  },
                });

                targets.push({
                  account: {
                    id: plan.account.id,
                    name: plan.account.name,
                    platform: plan.account.platform,
                    platformAccountId: plan.account.platformAccountId,
                    status: plan.account.status,
                  },
                  attempt: reservedAttempt,
                  accessToken: plan.accessToken,
                  previousContainerId: plan.previousContainerId,
                  skippedDueToError: false,
                });
              }
            }

            return {
              post: {
                id: post.id,
                caption: post.caption,
                hashtags: post.hashtags,
              },
              mediaAsset,
              targets,
            };
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

      // ETAPA 2: CHAMADAS EXTERNAS À META (TOTALMENTE FORA DE TRANSAÇÃO DE BANCO)
      // Nenhuma transação ou lock de banco é mantido durante requisições HTTP ou polling.
      const attemptsResult: PublicationAttemptDto[] = [];
      const fullCaption = [prepResult.post.caption, prepResult.post.hashtags]
        .filter(Boolean)
        .join("\n\n");

      let imageUrl: string | null = null;
      try {
        if (prepResult.mediaAsset) {
          // Gera identificador criptográfico opaco com TTL de 60 minutos no Redis
          const ticketId = await createPublicMediaTicket(redis, {
            organizationId,
            clientId,
            mediaId: prepResult.mediaAsset.id,
            storageKey: prepResult.mediaAsset.storageKey,
            mimeType: prepResult.mediaAsset.mimeType || "image/jpeg",
            byteSize: prepResult.mediaAsset.byteSize || 0,
            sha256: prepResult.mediaAsset.sha256 || "",
          });
          imageUrl = `${config.APP_URL}/api/public/media/${ticketId}`;
        }

        if (dependencies?.onBeforePublish) {
          await dependencies.onBeforePublish();
        }
      } catch (prepErr) {
        // Toda exceção pós-reserva e pré-Meta finaliza atomicamente as tentativas afetadas como FAILED
        // com código seguro PREPARATION_FAILED, auditando e liberando a chave de idempotência
        try {
          await shortTx(req, organizationId, clientId, async (tx, userId) => {
            for (const target of prepResult.targets) {
              if (!target.skippedDueToError) {
                await tx.publicationAttempt.update({
                  where: { id: target.attempt.id },
                  data: {
                    status: "FAILED",
                    errorCode: "PREPARATION_FAILED",
                    errorMessage:
                      "Falha na preparação da publicação antes do envio.",
                    leaseExpiresAt: null,
                  },
                });
                await audit(
                  tx,
                  req,
                  userId,
                  target.attempt.id,
                  "post.publish_failed",
                );
              }
            }
          });
        } catch (cleanupErr) {
          console.error(
            JSON.stringify({
              event: "publication_prep_cleanup_failed",
              error:
                cleanupErr instanceof Error
                  ? cleanupErr.message
                  : String(cleanupErr),
            }),
          );
        }

        try {
          await redis.del(redisKey);
        } catch {
          // Erro de limpeza do Redis ignorado intencionalmente
        }

        console.error(
          JSON.stringify({
            event: "publication_preparation_failed",
            error: prepErr instanceof Error ? prepErr.message : String(prepErr),
          }),
        );

        throw new PublicationError(
          503,
          "Falha na preparação da publicação. Tente novamente.",
        );
      }

      for (const target of prepResult.targets) {
        if (target.skippedDueToError) {
          attemptsResult.push({
            id: target.attempt.id,
            organizationId: target.attempt.organizationId,
            clientId: target.attempt.clientId,
            postId: target.attempt.postId,
            socialAccountId: target.attempt.socialAccountId,
            platform: target.account.platform,
            status: target.attempt.status as PublicationAttemptDto["status"],
            creationContainerId: target.attempt.creationContainerId,
            remoteMediaId: target.attempt.remoteMediaId,
            remotePermalink: target.attempt.remotePermalink,
            errorCode: target.attempt.errorCode,
            errorMessage: target.attempt.errorMessage,
            attemptNumber: target.attempt.attemptNumber,
            executedAt: target.attempt.executedAt,
            leaseExpiresAt: target.attempt.leaseExpiresAt ?? null,
            createdAt: target.attempt.createdAt,
            updatedAt: target.attempt.updatedAt,
          });
          continue;
        }

        const accessToken = target.accessToken!;
        let finalAttemptRecord: PublicationAttemptDto = {
          id: target.attempt.id,
          organizationId: target.attempt.organizationId,
          clientId: target.attempt.clientId,
          postId: target.attempt.postId,
          socialAccountId: target.attempt.socialAccountId,
          platform: target.account.platform,
          status: "FAILED",
          creationContainerId: target.attempt.creationContainerId,
          remoteMediaId: null,
          remotePermalink: null,
          errorCode: null,
          errorMessage: null,
          attemptNumber: target.attempt.attemptNumber,
          executedAt: target.attempt.executedAt,
          leaseExpiresAt: null,
          createdAt: target.attempt.createdAt,
          updatedAt: target.attempt.updatedAt,
        };

        let pubResult: {
          remoteMediaId: string;
          remotePermalink: string | null;
          creationContainerId?: string;
        } | null = null;

        try {
          if (target.account.platform === "FACEBOOK_PAGE") {
            pubResult = await publisher.publishFacebook({
              pageId: target.account.platformAccountId,
              accessToken,
              caption: fullCaption,
              imageUrl: imageUrl || undefined,
            });
          } else if (target.account.platform === "INSTAGRAM_BUSINESS") {
            pubResult = await publisher.publishInstagram(
              {
                igUserId: target.account.platformAccountId,
                accessToken,
                caption: fullCaption,
                imageUrl: imageUrl!,
              },
              {
                existingContainerId: target.previousContainerId,
                onContainerCreated: async (containerId) => {
                  // Transação curta para persistir container antes do polling e renovar lease
                  await shortTx(
                    req,
                    organizationId,
                    clientId,
                    async (tx, userId) => {
                      await tx.publicationAttempt.update({
                        where: { id: target.attempt.id },
                        data: {
                          status: "CONTAINER_CREATED",
                          creationContainerId: containerId,
                          leaseExpiresAt: new Date(
                            Date.now() + LEASE_DURATION_MS,
                          ),
                        },
                      });
                      await audit(
                        tx,
                        req,
                        userId,
                        target.attempt.id,
                        "post.container_created",
                      );
                    },
                  );
                },
              },
            );
          }

          // Transação curta de persistência do sucesso remoto
          try {
            const updated = await shortTx(
              req,
              organizationId,
              clientId,
              async (tx, userId) => {
                const res = await tx.publicationAttempt.update({
                  where: { id: target.attempt.id },
                  data: {
                    status: "PUBLISHED",
                    creationContainerId:
                      pubResult!.creationContainerId ??
                      target.attempt.creationContainerId,
                    remoteMediaId: pubResult!.remoteMediaId,
                    remotePermalink: pubResult!.remotePermalink,
                    leaseExpiresAt: null,
                  },
                });
                await audit(tx, req, userId, res.id, "post.published");
                return res;
              },
            );

            finalAttemptRecord = {
              ...finalAttemptRecord,
              status: "PUBLISHED",
              creationContainerId: updated.creationContainerId,
              remoteMediaId: updated.remoteMediaId,
              remotePermalink: updated.remotePermalink,
              leaseExpiresAt: null,
              updatedAt: updated.updatedAt,
            };
          } catch (persistErr) {
            // Sucesso remoto na Meta, mas houve falha ao salvar confirmação no banco.
            // Transiciona para UNCERTAIN com remoteMediaId para evitar republicação duplicada.
            console.error(
              JSON.stringify({
                event: "publication_post_success_persistence_failed",
                attemptId: target.attempt.id,
                error:
                  persistErr instanceof Error
                    ? persistErr.message
                    : String(persistErr),
              }),
            );

            try {
              const updated = await shortTx(
                req,
                organizationId,
                clientId,
                async (tx, userId) => {
                  const res = await tx.publicationAttempt.update({
                    where: { id: target.attempt.id },
                    data: {
                      status: "UNCERTAIN",
                      creationContainerId:
                        pubResult!.creationContainerId ??
                        target.attempt.creationContainerId,
                      remoteMediaId: pubResult!.remoteMediaId,
                      remotePermalink: pubResult!.remotePermalink,
                      errorCode: "REMOTE_SUCCESS_PERSISTENCE_FAILED",
                      errorMessage:
                        "Publicação realizada com sucesso na Meta, mas houve falha ao persistir confirmação local.",
                      leaseExpiresAt: null,
                    },
                  });
                  await audit(
                    tx,
                    req,
                    userId,
                    res.id,
                    "post.publish_uncertain",
                  );
                  return res;
                },
              );

              finalAttemptRecord = {
                ...finalAttemptRecord,
                status: "UNCERTAIN",
                creationContainerId: updated.creationContainerId,
                remoteMediaId: updated.remoteMediaId,
                remotePermalink: updated.remotePermalink,
                errorCode: updated.errorCode,
                errorMessage: updated.errorMessage,
                leaseExpiresAt: null,
                updatedAt: updated.updatedAt,
              };
            } catch {
              finalAttemptRecord = {
                ...finalAttemptRecord,
                status: "UNCERTAIN",
                creationContainerId:
                  pubResult!.creationContainerId ??
                  target.attempt.creationContainerId,
                remoteMediaId: pubResult!.remoteMediaId,
                remotePermalink: pubResult!.remotePermalink,
                errorCode: "REMOTE_SUCCESS_PERSISTENCE_FAILED",
                errorMessage:
                  "Publicação realizada com sucesso na Meta, mas houve falha ao persistir confirmação local.",
                leaseExpiresAt: null,
              };
            }
          }
        } catch (metaErr: unknown) {
          const timeout = isTimeoutError(metaErr);
          const isAuthError =
            (metaErr &&
              typeof metaErr === "object" &&
              "code" in metaErr &&
              Number((metaErr as { code?: unknown }).code) === 190) ||
            metaErr instanceof MetaAuthError ||
            (metaErr instanceof Error && metaErr.name === "MetaAuthError");

          if (timeout) {
            // Resultado remoto incerto: estado UNCERTAIN impede nova publicação acidental
            // e retém o bloqueio para reconciliação
            const updated = await shortTx(
              req,
              organizationId,
              clientId,
              async (tx, userId) => {
                const res = await tx.publicationAttempt.update({
                  where: { id: target.attempt.id },
                  data: {
                    status: "UNCERTAIN",
                    errorCode: "REMOTE_TIMEOUT",
                    errorMessage:
                      metaErr instanceof Error
                        ? metaErr.message
                        : "Tempo limite esgotado. Resultado remoto incerto.",
                    leaseExpiresAt: null,
                  },
                });
                await audit(tx, req, userId, res.id, "post.publish_uncertain");
                return res;
              },
            );

            finalAttemptRecord = {
              ...finalAttemptRecord,
              status: "UNCERTAIN",
              errorCode: updated.errorCode,
              errorMessage: updated.errorMessage,
              leaseExpiresAt: null,
              updatedAt: updated.updatedAt,
            };
          } else {
            // Falha com erro conhecido da Meta
            const errorCode =
              metaErr &&
              typeof metaErr === "object" &&
              "code" in metaErr &&
              (metaErr as { code?: unknown }).code
                ? String((metaErr as { code?: unknown }).code)
                : metaErr instanceof Error
                  ? metaErr.name
                  : "META_PUBLISH_ERROR";

            const errorMessage =
              metaErr instanceof Error
                ? metaErr.message
                : "Falha na comunicação com a Meta.";

            const updated = await shortTx(
              req,
              organizationId,
              clientId,
              async (tx, userId) => {
                if (isAuthError) {
                  await tx.socialAccount.update({
                    where: { id: target.account.id },
                    data: { status: "EXPIRED" },
                  });
                  await tx.oAuthCredential.update({
                    where: { socialAccountId: target.account.id },
                    data: {
                      reconnectReason:
                        "Token da Meta expirado ou revogado. Reconexão necessária.",
                    },
                  });
                }

                const res = await tx.publicationAttempt.update({
                  where: { id: target.attempt.id },
                  data: {
                    status: "FAILED",
                    errorCode,
                    errorMessage,
                    leaseExpiresAt: null,
                  },
                });
                await audit(tx, req, userId, res.id, "post.publish_failed");
                return res;
              },
            );

            finalAttemptRecord = {
              ...finalAttemptRecord,
              status: "FAILED",
              errorCode: updated.errorCode,
              errorMessage: updated.errorMessage,
              leaseExpiresAt: null,
              updatedAt: updated.updatedAt,
            };
          }
        }

        attemptsResult.push(finalAttemptRecord);
      }

      // ETAPA 3: FINALIZAÇÃO E RESPOSTA
      const allSuccess =
        attemptsResult.length > 0 &&
        attemptsResult.every((att) => att.status === "PUBLISHED");

      const finalResponse = publishPostResponse.parse({
        postId,
        success: allSuccess,
        attempts: attemptsResult,
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
