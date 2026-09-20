import type { Redis } from "ioredis";
import {
  createCredentialCrypto,
  type Prisma,
  type CredentialContext,
} from "@socialflow/db";
import {
  type PublicationAttemptDto,
  type SocialPlatform,
} from "@socialflow/contracts";
import {
  MetaPublisherAdapter,
  MetaAuthError,
  MetaMediaError,
  MetaPermissionError,
  MetaRateLimitError,
  MetaTimeoutError,
  isTimeoutError,
} from "./meta-publisher.js";
import { createPublicMediaTicket } from "./media-ticket.js";

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

export function isTransientError(err: unknown): boolean {
  if (!err) return false;
  if (
    err instanceof MetaAuthError ||
    (err as { name?: string }).name === "MetaAuthError"
  ) {
    return false;
  }
  if (
    err instanceof MetaMediaError ||
    (err as { name?: string }).name === "MetaMediaError"
  ) {
    return false;
  }
  if (
    err instanceof MetaPermissionError ||
    (err as { name?: string }).name === "MetaPermissionError"
  ) {
    return false;
  }
  if (
    err instanceof MetaTimeoutError ||
    (err as { name?: string }).name === "MetaTimeoutError"
  ) {
    return false;
  }
  if (
    err instanceof MetaRateLimitError ||
    (err as { name?: string }).name === "MetaRateLimitError"
  ) {
    return true;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("service unavailable") ||
      msg.includes("503") ||
      msg.includes("502") ||
      msg.includes("504") ||
      msg.includes("network error")
    ) {
      return true;
    }
  }
  return false;
}

export interface TargetPrep {
  account: {
    id: string;
    name: string | null;
    platform: SocialPlatform;
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
  alreadyPublished?: boolean;
}

export interface PreparePublicationParams {
  tx: Prisma.TransactionClient;
  organizationId: string;
  clientId: string;
  postId: string;
  socialAccountIds: string[];
  mediaAssetId?: string | null;
  masterKey: string | Buffer;
  scheduleId?: string | null;
  allowSkippingPublished?: boolean;
  auditCallback: (
    tx: Prisma.TransactionClient,
    entityId: string,
    action: string,
  ) => Promise<unknown>;
}

export interface PreparePublicationResult {
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
}

/**
 * ETAPA 1: Preparação de publicação dentro de transação de banco de dados curta.
 * Valida autorização, contas, mídia, chaves criptográficas e reservas idempotentes no PostgreSQL.
 */
export async function preparePublication(
  params: PreparePublicationParams,
): Promise<PreparePublicationResult> {
  const {
    tx,
    organizationId,
    clientId,
    postId,
    socialAccountIds,
    mediaAssetId,
    masterKey,
    scheduleId,
    allowSkippingPublished = false,
    auditCallback,
  } = params;

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

  const existingAttempts = await tx.publicationAttempt.findMany({
    where: {
      organizationId,
      clientId,
      postId,
      socialAccountId: { in: socialAccountIds },
    },
    orderBy: { attemptNumber: "desc" },
  });

  type AccountPlan =
    | {
        action: "SKIP_ALREADY_PUBLISHED";
        account: (typeof accounts)[number];
        attempt: (typeof existingAttempts)[number];
      }
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

    const published = accountAttempts.find((a) => a.status === "PUBLISHED");
    if (published) {
      if (allowSkippingPublished) {
        plans.push({
          action: "SKIP_ALREADY_PUBLISHED",
          account,
          attempt: published,
        });
        continue;
      }
      throw new PublicationError(
        409,
        `Post já publicado com sucesso para a conta social ${account.name || account.id}.`,
      );
    }

    const active = accountAttempts.find((a) =>
      ["PENDING", "PROCESSING", "CONTAINER_CREATED", "UNCERTAIN"].includes(
        a.status,
      ),
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

      if (account.platform === "INSTAGRAM_BUSINESS") {
        isInstagramResumption = true;
        previousContainerId = active.creationContainerId;
      } else {
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

    if (facebookExpiredAccount) {
      continue;
    }

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
        errorMessage: "Falha ao descriptografar token da conta social.",
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
      await auditCallback(tx, attemptId, "post.publish_uncertain");
    }

    return {
      uncertainAccount: facebookExpiredAccount,
      post: null as never,
      mediaAsset: null as never,
      targets: [] as never,
    };
  }

  const targets: TargetPrep[] = [];

  for (const plan of plans) {
    if (plan.action === "SKIP_ALREADY_PUBLISHED") {
      targets.push({
        account: {
          id: plan.account.id,
          name: plan.account.name,
          platform: plan.account.platform,
          platformAccountId: plan.account.platformAccountId,
          status: plan.account.status,
        },
        attempt: plan.attempt,
        skippedDueToError: false,
        alreadyPublished: true,
      });
    } else if (plan.action === "RECORD_FAILED") {
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
          scheduleId: scheduleId ?? null,
        },
      });
      await auditCallback(tx, failedAttempt.id, "post.publish_failed");
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
      await auditCallback(tx, plan.activeAttemptId, "post.lease_expired");

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
          scheduleId: scheduleId ?? null,
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
          scheduleId: scheduleId ?? null,
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
}

export interface ExecutePublicationParams {
  txRunner: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  auditCallback: (
    tx: Prisma.TransactionClient,
    entityId: string,
    action: string,
  ) => Promise<unknown>;
  publisher: MetaPublisherAdapter;
  prepResult: PreparePublicationResult;
  organizationId: string;
  clientId: string;
  appUrl: string;
  redis: Redis;
  onBeforePublish?: () => Promise<void>;
}

export interface ExecutePublicationResult {
  attempts: PublicationAttemptDto[];
  hasFailures: boolean;
  hasUncertain: boolean;
  hasSuccess: boolean;
  allSuccess: boolean;
}

/**
 * ETAPA 2: Execução das publicações remotas na Meta.
 * Todas as chamadas HTTP à Meta e polling ocorrem fora de transação de banco.
 */
export async function executePublication(
  params: ExecutePublicationParams,
): Promise<ExecutePublicationResult> {
  const {
    txRunner,
    auditCallback,
    publisher,
    prepResult,
    organizationId,
    clientId,
    appUrl,
    redis,
    onBeforePublish,
  } = params;

  const fullCaption = [prepResult.post.caption, prepResult.post.hashtags]
    .filter(Boolean)
    .join("\n\n");

  let imageUrl: string | null = null;
  try {
    if (prepResult.mediaAsset) {
      const ticketId = await createPublicMediaTicket(redis, {
        organizationId,
        clientId,
        mediaId: prepResult.mediaAsset.id,
        storageKey: prepResult.mediaAsset.storageKey,
        mimeType: prepResult.mediaAsset.mimeType || "image/jpeg",
        byteSize: prepResult.mediaAsset.byteSize || 0,
        sha256: prepResult.mediaAsset.sha256 || "",
      });
      imageUrl = `${appUrl}/api/public/media/${ticketId}`;
    }

    if (onBeforePublish) {
      await onBeforePublish();
    }
  } catch (prepErr) {
    try {
      await txRunner(async (tx) => {
        for (const target of prepResult.targets) {
          if (!target.skippedDueToError && !target.alreadyPublished) {
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
            await auditCallback(tx, target.attempt.id, "post.publish_failed");
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

  const attemptsResult: PublicationAttemptDto[] = [];

  for (const target of prepResult.targets) {
    if (target.alreadyPublished) {
      attemptsResult.push({
        id: target.attempt.id,
        organizationId: target.attempt.organizationId,
        clientId: target.attempt.clientId,
        postId: target.attempt.postId,
        socialAccountId: target.attempt.socialAccountId,
        platform: target.account.platform,
        status: "PUBLISHED",
        creationContainerId: target.attempt.creationContainerId,
        remoteMediaId: target.attempt.remoteMediaId,
        remotePermalink: target.attempt.remotePermalink,
        errorCode: target.attempt.errorCode,
        errorMessage: target.attempt.errorMessage,
        attemptNumber: target.attempt.attemptNumber,
        executedAt: target.attempt.executedAt,
        leaseExpiresAt: null,
        createdAt: target.attempt.createdAt,
        updatedAt: target.attempt.updatedAt,
      });
      continue;
    }

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
              await txRunner(async (tx) => {
                await tx.publicationAttempt.update({
                  where: { id: target.attempt.id },
                  data: {
                    status: "CONTAINER_CREATED",
                    creationContainerId: containerId,
                    leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
                  },
                });
                await auditCallback(
                  tx,
                  target.attempt.id,
                  "post.container_created",
                );
              });
            },
          },
        );
      }

      try {
        const updated = await txRunner(async (tx) => {
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
          await auditCallback(tx, res.id, "post.published");
          return res;
        });

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
          const updated = await txRunner(async (tx) => {
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
            await auditCallback(tx, res.id, "post.publish_uncertain");
            return res;
          });

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
        const updated = await txRunner(async (tx) => {
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
          await auditCallback(tx, res.id, "post.publish_uncertain");
          return res;
        });

        finalAttemptRecord = {
          ...finalAttemptRecord,
          status: "UNCERTAIN",
          errorCode: updated.errorCode,
          errorMessage: updated.errorMessage,
          leaseExpiresAt: null,
          updatedAt: updated.updatedAt,
        };
      } else {
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

        const updated = await txRunner(async (tx) => {
          if (isAuthError) {
            await tx.socialAccount.update({
              where: { id: target.account.id },
              data: { status: "EXPIRED" },
            });
            try {
              await tx.oAuthCredential.update({
                where: { socialAccountId: target.account.id },
                data: {
                  reconnectReason:
                    "Token da Meta expirado ou revogado. Reconexão necessária.",
                },
              });
            } catch {
              // Scheduler possui acesso estritamente SELECT-only em OAuthCredential por política de segurança RLS
            }
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
          await auditCallback(tx, res.id, "post.publish_failed");
          return res;
        });

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

  const allSuccess =
    attemptsResult.length > 0 &&
    attemptsResult.every((att) => att.status === "PUBLISHED");
  const hasSuccess = attemptsResult.some((att) => att.status === "PUBLISHED");
  const hasFailures = attemptsResult.some((att) => att.status === "FAILED");
  const hasUncertain = attemptsResult.some((att) => att.status === "UNCERTAIN");

  return {
    attempts: attemptsResult,
    hasFailures,
    hasUncertain,
    hasSuccess,
    allSuccess,
  };
}
