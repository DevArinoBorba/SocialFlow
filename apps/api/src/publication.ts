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
  type PublicationAttemptDto,
  type Role,
} from "@socialflow/contracts";
import { MetaPublisherAdapter, MetaAuthError } from "./meta-publisher.js";
import { createSignedMediaToken } from "./media-token.js";

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

export class PublicationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "PublicationError";
  }
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
        const status =
          error &&
          typeof error === "object" &&
          "status" in error &&
          typeof error.status === "number"
            ? error.status
            : error instanceof PublicationError
              ? error.status
              : 503;

        if (status !== 503) {
          res.status(status).json({
            message:
              error instanceof Error ? error.message : "Erro na requisição.",
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

      // Idempotência no Redis para prevenir duplo clique e execuções concorrentes
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

      try {
        const result = await accessScope(
          req,
          organizationId,
          clientId,
          ["OWNER", "ADMIN", "APPROVER"],
          async (tx, userId) => {
            // 1. Validação estrita do Post: deve pertencer ao cliente e estar APPROVED
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

            // 2. Validação das Contas Sociais: devem pertencer ao mesmo cliente
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

            // 3. Validação de Mídia (se fornecida ou obrigatória para Instagram)
            const hasInstagram = accounts.some(
              (acc) => acc.platform === "INSTAGRAM_BUSINESS",
            );
            if (hasInstagram && !mediaAssetId) {
              throw new PublicationError(
                400,
                "Publicações no Instagram exigem a seleção de uma imagem.",
              );
            }

            let imageUrl: string | null = null;
            if (mediaAssetId) {
              const asset = await tx.mediaAsset.findFirst({
                where: {
                  id: mediaAssetId,
                  organizationId,
                  clientId,
                  status: "ready",
                  archived: false,
                },
              });

              if (!asset) {
                throw new PublicationError(
                  404,
                  "Imagem selecionada não encontrada ou não está disponível.",
                );
              }

              const signedToken = createSignedMediaToken(
                config.SESSION_SECRET,
                {
                  organizationId,
                  clientId,
                  mediaId: asset.id,
                  storageKey: asset.storageKey,
                  mimeType: asset.mimeType || "image/jpeg",
                  byteSize: asset.byteSize || 0,
                  sha256: asset.sha256 || "",
                  expiresAt: Date.now() + 15 * 60 * 1000,
                },
              );

              imageUrl = `${config.APP_URL}/api/public/media/${signedToken}`;
            }

            // 4. Inicializa Decriptação Segura
            if (!masterKey) {
              throw new PublicationError(
                500,
                "Chave mestra de credenciais não configurada.",
              );
            }
            const credentialCrypto = createCredentialCrypto(masterKey);

            if (dependencies?.onBeforePublish) {
              await dependencies.onBeforePublish();
            }

            const attemptsResult: PublicationAttemptDto[] = [];
            const fullCaption = [post.caption, post.hashtags]
              .filter(Boolean)
              .join("\n\n");

            // 5. Publicação iterativa e isolada por conta social
            for (const account of accounts) {
              // Verifica tentativa anterior para calcular attemptNumber
              const lastAttempt = await tx.publicationAttempt.findFirst({
                where: {
                  organizationId,
                  clientId,
                  postId,
                  socialAccountId: account.id,
                },
                orderBy: { attemptNumber: "desc" },
              });
              const attemptNumber = (lastAttempt?.attemptNumber ?? 0) + 1;

              // Cria tentativa no estado PENDING
              let attempt = await tx.publicationAttempt.create({
                data: {
                  organizationId,
                  clientId,
                  postId,
                  socialAccountId: account.id,
                  status: "PENDING",
                  attemptNumber,
                  executedAt: new Date(),
                },
              });

              // Valida status da conta e presença de credencial
              if (account.status !== "ACTIVE" || !account.credential) {
                attempt = await tx.publicationAttempt.update({
                  where: { id: attempt.id },
                  data: {
                    status: "FAILED",
                    errorCode: "ACCOUNT_INACTIVE",
                    errorMessage:
                      account.status === "ACTIVE"
                        ? "Credencial OAuth ausente. Reconecte a conta."
                        : `Conta social em estado ${account.status}. Reconexão necessária.`,
                  },
                });
                await audit(tx, req, userId, attempt.id, "post.publish_failed");
                attemptsResult.push({
                  id: attempt.id,
                  organizationId: attempt.organizationId,
                  clientId: attempt.clientId,
                  postId: attempt.postId,
                  socialAccountId: attempt.socialAccountId,
                  platform: account.platform,
                  status: attempt.status,
                  creationContainerId: attempt.creationContainerId,
                  remoteMediaId: attempt.remoteMediaId,
                  remotePermalink: attempt.remotePermalink,
                  errorCode: attempt.errorCode,
                  errorMessage: attempt.errorMessage,
                  attemptNumber: attempt.attemptNumber,
                  executedAt: attempt.executedAt,
                  createdAt: attempt.createdAt,
                  updatedAt: attempt.updatedAt,
                });
                continue;
              }

              // Decripta o Page Access Token em memória
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
                attempt = await tx.publicationAttempt.update({
                  where: { id: attempt.id },
                  data: {
                    status: "FAILED",
                    errorCode: "CRYPTO_DECRYPT_FAILED",
                    errorMessage:
                      "Falha ao descriptografar token da conta social.",
                  },
                });
                await audit(tx, req, userId, attempt.id, "post.publish_failed");
                attemptsResult.push({
                  id: attempt.id,
                  organizationId: attempt.organizationId,
                  clientId: attempt.clientId,
                  postId: attempt.postId,
                  socialAccountId: attempt.socialAccountId,
                  platform: account.platform,
                  status: attempt.status,
                  creationContainerId: attempt.creationContainerId,
                  remoteMediaId: attempt.remoteMediaId,
                  remotePermalink: attempt.remotePermalink,
                  errorCode: attempt.errorCode,
                  errorMessage: attempt.errorMessage,
                  attemptNumber: attempt.attemptNumber,
                  executedAt: attempt.executedAt,
                  createdAt: attempt.createdAt,
                  updatedAt: attempt.updatedAt,
                });
                continue;
              }

              // Executa publicação via Adaptador Meta Isolado
              try {
                if (account.platform === "FACEBOOK_PAGE") {
                  const pubResult = await publisher.publishFacebook({
                    pageId: account.platformAccountId,
                    accessToken,
                    caption: fullCaption,
                    imageUrl: imageUrl || undefined,
                  });

                  attempt = await tx.publicationAttempt.update({
                    where: { id: attempt.id },
                    data: {
                      status: "PUBLISHED",
                      remoteMediaId: pubResult.remoteMediaId,
                      remotePermalink: pubResult.remotePermalink,
                    },
                  });
                  await audit(tx, req, userId, attempt.id, "post.published");
                } else if (account.platform === "INSTAGRAM_BUSINESS") {
                  const pubResult = await publisher.publishInstagram(
                    {
                      igUserId: account.platformAccountId,
                      accessToken,
                      caption: fullCaption,
                      imageUrl: imageUrl!,
                    },
                    async (containerId) => {
                      attempt = await tx.publicationAttempt.update({
                        where: { id: attempt.id },
                        data: {
                          status: "CONTAINER_CREATED",
                          creationContainerId: containerId,
                        },
                      });
                    },
                  );

                  attempt = await tx.publicationAttempt.update({
                    where: { id: attempt.id },
                    data: {
                      status: "PUBLISHED",
                      creationContainerId: pubResult.creationContainerId,
                      remoteMediaId: pubResult.remoteMediaId,
                      remotePermalink: pubResult.remotePermalink,
                    },
                  });
                  await audit(tx, req, userId, attempt.id, "post.published");
                }
              } catch (metaErr: unknown) {
                const isAuthError =
                  (metaErr &&
                    typeof metaErr === "object" &&
                    "code" in metaErr &&
                    Number((metaErr as { code?: unknown }).code) === 190) ||
                  metaErr instanceof MetaAuthError ||
                  (metaErr instanceof Error &&
                    metaErr.name === "MetaAuthError");

                if (isAuthError) {
                  // Marca conta social como EXPIRED para exigir reconexão
                  await tx.socialAccount.update({
                    where: { id: account.id },
                    data: {
                      status: "EXPIRED",
                    },
                  });
                  await tx.oAuthCredential.update({
                    where: { socialAccountId: account.id },
                    data: {
                      reconnectReason:
                        "Token da Meta expirado ou revogado. Reconexão necessária.",
                    },
                  });
                }

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

                attempt = await tx.publicationAttempt.update({
                  where: { id: attempt.id },
                  data: {
                    status: "FAILED",
                    errorCode,
                    errorMessage,
                  },
                });
                await audit(tx, req, userId, attempt.id, "post.publish_failed");
              }

              attemptsResult.push({
                id: attempt.id,
                organizationId: attempt.organizationId,
                clientId: attempt.clientId,
                postId: attempt.postId,
                socialAccountId: attempt.socialAccountId,
                platform: account.platform,
                status: attempt.status,
                creationContainerId: attempt.creationContainerId,
                remoteMediaId: attempt.remoteMediaId,
                remotePermalink: attempt.remotePermalink,
                errorCode: attempt.errorCode,
                errorMessage: attempt.errorMessage,
                attemptNumber: attempt.attemptNumber,
                executedAt: attempt.executedAt,
                createdAt: attempt.createdAt,
                updatedAt: attempt.updatedAt,
              });
            }

            const allSuccess =
              attemptsResult.length > 0 &&
              attemptsResult.every((att) => att.status === "PUBLISHED");

            const finalResponse = publishPostResponse.parse({
              postId,
              success: allSuccess,
              attempts: attemptsResult,
            });

            return finalResponse;
          },
        );

        // Salva resultado concluído no Redis com TTL de 24h
        await redis.set(redisKey, JSON.stringify(result), "EX", 86400);

        res.status(200).json(result);
      } catch (err) {
        // Se ocorreu um erro antes de concluir, remove a chave para permitir nova tentativa
        await redis.del(redisKey);
        throw err;
      }
    }),
  );
}
