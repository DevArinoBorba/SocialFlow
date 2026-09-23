import type { Express, Request, Response } from "express";
import type { Queue } from "bullmq";
import type {
  Prisma,
  RenderBatchStatus,
  RenderBatchSourceType,
  DesignFormat,
} from "@socialflow/db";
import {
  type Role,
  renderBatchCreateSchema,
  renderBatchValidateSchema,
  renderBatchListQuerySchema,
  renderBatchItemsQuerySchema,
  renderBatchRetryFailedSchema,
  computeBatchAggregateStatus,
  type RenderBatchCreate,
  type RenderBatchValidate,
  type RenderBatchRetryFailed,
  type RenderBatchDto,
  designTemplateSpecSchema,
  type ArtworkInput,
} from "@socialflow/contracts";
import {
  hashRenderInput,
  computeBatchRequestFingerprint,
  RENDERER_VERSION,
} from "@socialflow/render";
import { getRenderQueueJobId, type RenderJobData } from "./render-queue.js";
import { sanitizeErrorMessage } from "./log-sanitizer.js";
import { HttpError } from "./errors.js";
import {
  type Scope,
  disallowedContentPattern,
  validateMediaAssetRecord,
  toRenderJobDto,
} from "./render.js";

export class RenderBatchError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RenderBatchError";
  }
}

export function toRenderBatchDto(batch: {
  id: string;
  templateVersionId: string;
  sourceType: RenderBatchSourceType;
  contentBatchId: string | null;
  parentBatchId?: string | null;
  format: DesignFormat;
  status: RenderBatchStatus;
  requestHash: string;
  totalItems: number;
  pendingItems: number;
  processingItems: number;
  completedItems: number;
  failedItems: number;
  cancelledItems: number;
  cancelRequestedAt: Date | string | null;
  cancelCompletedAt: Date | string | null;
  completedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): RenderBatchDto {
  return {
    id: batch.id,
    templateVersionId: batch.templateVersionId,
    sourceType: batch.sourceType,
    contentBatchId: batch.contentBatchId,
    parentBatchId: batch.parentBatchId ?? null,
    format: batch.format,
    status: batch.status,
    requestHash: batch.requestHash,
    totalItems: batch.totalItems,
    pendingItems: batch.pendingItems,
    processingItems: batch.processingItems,
    completedItems: batch.completedItems,
    failedItems: batch.failedItems,
    cancelledItems: batch.cancelledItems,
    cancelRequestedAt: batch.cancelRequestedAt
      ? batch.cancelRequestedAt instanceof Date
        ? batch.cancelRequestedAt.toISOString()
        : String(batch.cancelRequestedAt)
      : null,
    cancelCompletedAt: batch.cancelCompletedAt
      ? batch.cancelCompletedAt instanceof Date
        ? batch.cancelCompletedAt.toISOString()
        : String(batch.cancelCompletedAt)
      : null,
    completedAt: batch.completedAt
      ? batch.completedAt instanceof Date
        ? batch.completedAt.toISOString()
        : String(batch.completedAt)
      : null,
    createdAt:
      batch.createdAt instanceof Date
        ? batch.createdAt.toISOString()
        : String(batch.createdAt),
    updatedAt:
      batch.updatedAt instanceof Date
        ? batch.updatedAt.toISOString()
        : String(batch.updatedAt),
  };
}

function validateBatchArtworkInputText(input: ArtworkInput): string[] {
  const reasons: string[] = [];
  const fieldsToCheck = [
    { name: "Título", value: input.title },
    { name: "Eyebrow", value: input.eyebrow },
    { name: "Subtítulo", value: input.subtitle },
    { name: "Call to Action", value: input.callToAction },
  ];

  for (const { name, value } of fieldsToCheck) {
    if (value && disallowedContentPattern.test(value)) {
      reasons.push(
        `${name} contém conteúdo não permitido (HTML, CSS, URLs ou scripts).`,
      );
    }
  }

  return reasons;
}

function buildArtworkInputFromPost(
  post: {
    title: string | null;
    caption: string;
    callToAction: string | null;
  },
  defaults?: {
    backgroundMediaAssetId?: string | null;
    logoMediaAssetId?: string | null;
  },
): ArtworkInput {
  const title = (post.title || post.caption || "Publicação").slice(0, 100);
  const subtitle = post.title ? post.caption.slice(0, 140) : "";
  const callToAction = post.callToAction ?? "";

  return {
    title,
    eyebrow: "",
    subtitle,
    callToAction,
    backgroundMediaAssetId: defaults?.backgroundMediaAssetId ?? null,
    logoMediaAssetId: defaults?.logoMediaAssetId ?? null,
  };
}

export function registerRenderBatch(
  server: Express,
  scoped: Scope,
  renderQueue: Queue<RenderJobData>,
) {
  const root = "/api/organizations/:org/clients/:clientId/render-batches";
  const param = (req: Request, name: string) => String(req.params[name]);

  async function access<T>(
    req: Request,
    allowedRoles: Role[],
    fn: (
      tx: Prisma.TransactionClient,
      userId: string,
      role: Role,
      admin: boolean,
    ) => Promise<T>,
  ) {
    const organizationId = param(req, "org");
    const clientId = param(req, "clientId");

    return scoped(req, organizationId, async (tx, userId, admin) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, organizationId, active: true },
      });
      if (!client) throw new RenderBatchError(404, "Cliente não encontrado.");

      let effectiveRole: Role = admin ? "ADMIN" : "CLIENT_VIEWER";
      if (!admin) {
        const clientMembership = await tx.membership.findFirst({
          where: {
            userId,
            organizationId,
            clientId,
            active: true,
          },
        });
        if (!clientMembership) {
          throw new RenderBatchError(404, "Cliente não encontrado.");
        }
        effectiveRole = clientMembership.role;
      } else {
        const orgMembership = await tx.membership.findFirst({
          where: {
            userId,
            organizationId,
            clientId: null,
            active: true,
          },
        });
        if (orgMembership) {
          effectiveRole = orgMembership.role;
        }
      }

      if (!allowedRoles.includes(effectiveRole)) {
        throw new RenderBatchError(
          403,
          "Acesso não autorizado para o seu perfil.",
        );
      }

      return fn(tx, userId, effectiveRole, admin);
    });
  }

  function handler(fn: (req: Request, res: Response) => Promise<unknown>) {
    return async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (error: unknown) {
        if (error instanceof RenderBatchError) {
          res.status(error.status).json({ message: error.message });
          return;
        }

        if (error instanceof HttpError) {
          res.status(error.status).json({ message: error.message });
          return;
        }

        const sanitized = sanitizeErrorMessage(error);
        console.error(
          JSON.stringify({
            event: "render_batch_request_failed",
            errorCode: "INTERNAL_UNEXPECTED_ERROR",
            error: sanitized,
          }),
        );
        if (!res.headersSent) {
          res
            .status(503)
            .json({ message: "Serviço indisponível. Tente novamente." });
        }
      }
    };
  }

  const renderBatchSelect = {
    id: true,
    organizationId: true,
    clientId: true,
    templateVersionId: true,
    sourceType: true,
    contentBatchId: true,
    parentBatchId: true,
    format: true,
    status: true,
    requestHash: true,
    totalItems: true,
    pendingItems: true,
    processingItems: true,
    completedItems: true,
    failedItems: true,
    cancelledItems: true,
    idempotencyKey: true,
    cancelRequestedAt: true,
    cancelCompletedAt: true,
    createdById: true,
    createdAt: true,
    updatedAt: true,
    completedAt: true,
  } as const;

  const renderJobSelect = {
    id: true,
    organizationId: true,
    clientId: true,
    status: true,
    templateVersionId: true,
    postId: true,
    backgroundMediaAssetId: true,
    logoMediaAssetId: true,
    outputMediaAssetId: true,
    input: true,
    inputHash: true,
    attemptNumber: true,
    errorCode: true,
    createdAt: true,
    updatedAt: true,
    completedAt: true,
  } as const;

  // 1. Pré-validação de lote (dry-run)
  server.post(
    `${root}/validate`,
    handler(async (req, res) => {
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");

      const parseResult = renderBatchValidateSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new RenderBatchError(
          400,
          "Dados de validação de lote de renderização inválidos.",
        );
      }
      const payload: RenderBatchValidate = parseResult.data;

      const report = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR"],
        async (tx) => {
          // Template
          const templateVersion = await tx.designTemplateVersion.findFirst({
            where: {
              id: payload.templateVersionId,
              organizationId,
              clientId,
            },
            include: { template: true },
          });

          if (!templateVersion) {
            throw new RenderBatchError(
              404,
              "Template de design não encontrado.",
            );
          }
          if (templateVersion.template.status !== "ACTIVE") {
            throw new RenderBatchError(
              400,
              "O template de design selecionado não está ativo.",
            );
          }
          if (templateVersion.rendererVersion !== RENDERER_VERSION) {
            throw new RenderBatchError(
              400,
              "Versão do renderizador incompatível com este template.",
            );
          }

          const specParse = designTemplateSpecSchema.safeParse(
            templateVersion.spec,
          );
          if (!specParse.success) {
            throw new RenderBatchError(
              400,
              "Especificação técnica do template é inválida.",
            );
          }

          // Validar mídias padrões se fornecidas
          if (payload.defaults?.backgroundMediaAssetId) {
            const bgAsset = await tx.mediaAsset.findFirst({
              where: {
                id: payload.defaults.backgroundMediaAssetId,
                organizationId,
                clientId,
              },
            });
            if (!bgAsset) {
              throw new RenderBatchError(
                400,
                "Imagem de fundo padrão não encontrada.",
              );
            }
            validateMediaAssetRecord(bgAsset, "Imagem de fundo padrão");
          }

          if (payload.defaults?.logoMediaAssetId) {
            const logoAsset = await tx.mediaAsset.findFirst({
              where: {
                id: payload.defaults.logoMediaAssetId,
                organizationId,
                clientId,
              },
            });
            if (!logoAsset) {
              throw new RenderBatchError(
                400,
                "Logotipo padrão não encontrado.",
              );
            }
            validateMediaAssetRecord(logoAsset, "Logotipo padrão");
          }

          // Coletar posts de acordo com a fonte
          let posts: Array<{
            id: string;
            title: string | null;
            caption: string;
            callToAction: string | null;
          }>;

          if (payload.source.type === "POSTS_SELECTION") {
            const foundPosts = await tx.post.findMany({
              where: {
                organizationId,
                clientId,
                id: { in: payload.source.postIds },
              },
              select: {
                id: true,
                title: true,
                caption: true,
                callToAction: true,
              },
            });

            // Ordenar de acordo com a ordem da lista enviada
            const map = new Map(foundPosts.map((p) => [p.id, p]));
            posts = payload.source.postIds
              .map((id) => map.get(id))
              .filter(
                (
                  p,
                ): p is {
                  id: string;
                  title: string | null;
                  caption: string;
                  callToAction: string | null;
                } => Boolean(p),
              );

            if (posts.length !== payload.source.postIds.length) {
              throw new RenderBatchError(
                404,
                "Uma ou mais publicações selecionadas não foram encontradas no cliente.",
              );
            }
          } else {
            const batch = await tx.contentBatch.findFirst({
              where: {
                id: payload.source.contentBatchId,
                organizationId,
                clientId,
              },
            });
            if (!batch) {
              throw new RenderBatchError(
                404,
                "Lote de conteúdo de origem não encontrado.",
              );
            }

            const totalCount = await tx.post.count({
              where: {
                organizationId,
                clientId,
                batchId: payload.source.contentBatchId,
              },
            });

            if (totalCount > 100) {
              throw new RenderBatchError(
                400,
                `O lote de conteúdo possui ${totalCount} publicações. O limite máximo permitido por lote de renderização é de 100 publicações.`,
              );
            }

            posts = await tx.post.findMany({
              where: {
                organizationId,
                clientId,
                batchId: payload.source.contentBatchId,
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: {
                id: true,
                title: true,
                caption: true,
                callToAction: true,
              },
            });
          }

          // Validação item a item
          const validItems: Array<{
            index: number;
            postId: string;
            input: ArtworkInput;
          }> = [];
          const invalidItems: Array<{
            index: number;
            postId: string;
            reasons: string[];
          }> = [];

          for (let i = 0; i < posts.length; i++) {
            const post = posts[i];
            if (!post) continue;
            const input = buildArtworkInputFromPost(post, payload.defaults);
            const textReasons = validateBatchArtworkInputText(input);

            if (textReasons.length === 0) {
              validItems.push({
                index: i,
                postId: post.id,
                input,
              });
            } else {
              invalidItems.push({
                index: i,
                postId: post.id,
                reasons: textReasons,
              });
            }
          }

          return {
            valid: invalidItems.length === 0,
            totalRequested: posts.length,
            validItemsCount: validItems.length,
            invalidItemsCount: invalidItems.length,
            validItems,
            invalidItems,
            estimatedDurationMs: validItems.length * 400,
          };
        },
      );

      res.status(200).json(report);
    }),
  );

  // 2. Criar solicitação de lote de renderização
  server.post(
    root,
    handler(async (req, res) => {
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");

      const parseResult = renderBatchCreateSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new RenderBatchError(
          400,
          "Dados de solicitação de lote de renderização inválidos.",
        );
      }
      const payload: RenderBatchCreate = parseResult.data;

      type CreateBatchResult = {
        batch: {
          id: string;
          organizationId: string;
          clientId: string;
          templateVersionId: string;
          sourceType: RenderBatchSourceType;
          contentBatchId: string | null;
          parentBatchId: string | null;
          format: DesignFormat;
          status: RenderBatchStatus;
          requestHash: string;
          totalItems: number;
          pendingItems: number;
          processingItems: number;
          completedItems: number;
          failedItems: number;
          cancelledItems: number;
          idempotencyKey: string;
          cancelRequestedAt: Date | null;
          cancelCompletedAt: Date | null;
          createdById: string;
          createdAt: Date;
          updatedAt: Date;
          completedAt: Date | null;
        };
        jobs: Array<{
          id: string;
          organizationId: string;
          clientId: string;
          batchId: string | null;
        }>;
        isReplay: boolean;
      };

      let result: CreateBatchResult;

      try {
        result = await access(
          req,
          ["OWNER", "ADMIN", "EDITOR"],
          async (tx, userId) => {
            // 1. Coletar e ordenar posts de forma determinística
            let posts: Array<{
              id: string;
              title: string | null;
              caption: string;
              callToAction: string | null;
            }>;

            if (payload.source.type === "POSTS_SELECTION") {
              const foundPosts = await tx.post.findMany({
                where: {
                  organizationId,
                  clientId,
                  id: { in: payload.source.postIds },
                },
                select: {
                  id: true,
                  title: true,
                  caption: true,
                  callToAction: true,
                },
              });

              const map = new Map(foundPosts.map((p) => [p.id, p]));
              posts = payload.source.postIds
                .map((id) => map.get(id))
                .filter(
                  (
                    p,
                  ): p is {
                    id: string;
                    title: string | null;
                    caption: string;
                    callToAction: string | null;
                  } => Boolean(p),
                );

              if (posts.length !== payload.source.postIds.length) {
                throw new RenderBatchError(
                  404,
                  "Uma ou mais publicações selecionadas não foram encontradas no cliente.",
                );
              }
            } else {
              const batch = await tx.contentBatch.findFirst({
                where: {
                  id: payload.source.contentBatchId,
                  organizationId,
                  clientId,
                },
              });
              if (!batch) {
                throw new RenderBatchError(
                  404,
                  "Lote de conteúdo de origem não encontrado.",
                );
              }

              const totalCount = await tx.post.count({
                where: {
                  organizationId,
                  clientId,
                  batchId: payload.source.contentBatchId,
                },
              });

              if (totalCount > 100) {
                throw new RenderBatchError(
                  400,
                  `O lote de conteúdo possui ${totalCount} publicações. O limite máximo permitido por lote de renderização é de 100 publicações.`,
                );
              }

              posts = await tx.post.findMany({
                where: {
                  organizationId,
                  clientId,
                  batchId: payload.source.contentBatchId,
                },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                select: {
                  id: true,
                  title: true,
                  caption: true,
                  callToAction: true,
                },
              });

              if (posts.length === 0) {
                throw new RenderBatchError(
                  422,
                  "O lote de conteúdo de origem não possui publicações para renderização.",
                );
              }
            }

            // 2. Snapshot e cálculo do fingerprint canônico da requisição
            const resolvedPostIds = posts.map((p) => p.id);
            const requestHash = computeBatchRequestFingerprint({
              organizationId,
              clientId,
              templateVersionId: payload.templateVersionId,
              format: payload.format,
              sourceType: payload.source.type,
              resolvedPostIds,
              defaults: payload.defaults,
            });

            // 3. Consulta de idempotência persistente via fingerprint SHA-256
            const existingBatch = await tx.renderBatch.findFirst({
              where: {
                organizationId,
                clientId,
                idempotencyKey: payload.idempotencyKey,
              },
              select: renderBatchSelect,
            });

            if (existingBatch) {
              if (existingBatch.requestHash === requestHash) {
                return {
                  batch: existingBatch,
                  jobs: [],
                  isReplay: true,
                };
              }
              throw new RenderBatchError(
                409,
                "Conflito de idempotência: a chave já foi utilizada com outros parâmetros.",
              );
            }

            // 4. Validações do Template
            const templateVersion = await tx.designTemplateVersion.findFirst({
              where: {
                id: payload.templateVersionId,
                organizationId,
                clientId,
              },
              include: { template: true },
            });

            if (!templateVersion) {
              throw new RenderBatchError(
                404,
                "Template de design não encontrado.",
              );
            }
            if (templateVersion.template.status !== "ACTIVE") {
              throw new RenderBatchError(
                400,
                "O template de design selecionado não está ativo.",
              );
            }
            if (templateVersion.rendererVersion !== RENDERER_VERSION) {
              throw new RenderBatchError(
                400,
                "Versão do renderizador incompatível com este template.",
              );
            }

            const specParse = designTemplateSpecSchema.safeParse(
              templateVersion.spec,
            );
            if (!specParse.success) {
              throw new RenderBatchError(
                400,
                "Especificação técnica do template é inválida.",
              );
            }
            const spec = specParse.data;

            // 5. Validação de mídias padrão
            if (payload.defaults?.backgroundMediaAssetId) {
              const bgAsset = await tx.mediaAsset.findFirst({
                where: {
                  id: payload.defaults.backgroundMediaAssetId,
                  organizationId,
                  clientId,
                },
              });
              if (!bgAsset) {
                throw new RenderBatchError(
                  400,
                  "Imagem de fundo padrão não encontrada.",
                );
              }
              validateMediaAssetRecord(bgAsset, "Imagem de fundo padrão");
            }

            if (payload.defaults?.logoMediaAssetId) {
              const logoAsset = await tx.mediaAsset.findFirst({
                where: {
                  id: payload.defaults.logoMediaAssetId,
                  organizationId,
                  clientId,
                },
              });
              if (!logoAsset) {
                throw new RenderBatchError(
                  400,
                  "Logotipo padrão não encontrado.",
                );
              }
              validateMediaAssetRecord(logoAsset, "Logotipo padrão");
            }

            // 6. Validar itens e montar dados
            const validatedItemsData: Array<{
              postId: string;
              backgroundMediaAssetId: string | null;
              logoMediaAssetId: string | null;
              input: ArtworkInput;
              inputHash: string;
            }> = [];

            for (let i = 0; i < posts.length; i++) {
              const post = posts[i];
              if (!post) continue;
              const input = buildArtworkInputFromPost(post, payload.defaults);
              const textReasons = validateBatchArtworkInputText(input);
              if (textReasons.length > 0) {
                throw new RenderBatchError(
                  422,
                  `Item #${i + 1}: ${textReasons.join(" ")}`,
                );
              }

              const inputHash = hashRenderInput(spec, input);
              validatedItemsData.push({
                postId: post.id,
                backgroundMediaAssetId: input.backgroundMediaAssetId ?? null,
                logoMediaAssetId: input.logoMediaAssetId ?? null,
                input,
                inputHash,
              });
            }

            // 7. Criar RenderBatch em PENDING
            const newBatch = await tx.renderBatch.create({
              data: {
                organizationId,
                clientId,
                templateVersionId: payload.templateVersionId,
                sourceType: payload.source.type,
                contentBatchId:
                  payload.source.type === "CONTENT_BATCH"
                    ? payload.source.contentBatchId
                    : null,
                format: payload.format,
                status: "PENDING",
                requestHash,
                totalItems: validatedItemsData.length,
                pendingItems: validatedItemsData.length,
                processingItems: 0,
                completedItems: 0,
                failedItems: 0,
                cancelledItems: 0,
                idempotencyKey: payload.idempotencyKey,
                createdById: userId,
              },
              select: renderBatchSelect,
            });

            // 8. Criar RenderJobs
            const createdJobs: Array<{
              id: string;
              organizationId: string;
              clientId: string;
              batchId: string | null;
            }> = [];

            for (let idx = 0; idx < validatedItemsData.length; idx++) {
              const item = validatedItemsData[idx];
              if (!item) continue;
              const job = await tx.renderJob.create({
                data: {
                  organizationId,
                  clientId,
                  batchId: newBatch.id,
                  templateVersionId: payload.templateVersionId,
                  postId: item.postId,
                  backgroundMediaAssetId: item.backgroundMediaAssetId,
                  logoMediaAssetId: item.logoMediaAssetId,
                  status: "PENDING",
                  input: item.input as unknown as Prisma.InputJsonValue,
                  inputHash: item.inputHash,
                  idempotencyKey: `${payload.idempotencyKey}:${idx}`,
                  createdById: userId,
                },
                select: {
                  id: true,
                  organizationId: true,
                  clientId: true,
                  batchId: true,
                },
              });
              createdJobs.push(job);
            }

            // 9. Auditoria
            await tx.auditLog.create({
              data: {
                organizationId,
                actorUserId: userId,
                entityId: newBatch.id,
                action: "batch.created",
              },
            });

            return {
              batch: newBatch,
              jobs: createdJobs,
              isReplay: false,
            };
          },
        );
      } catch (error: unknown) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "P2002"
        ) {
          const existingBatch = await access(
            req,
            ["OWNER", "ADMIN", "EDITOR"],
            async (tx) => {
              return tx.renderBatch.findFirst({
                where: {
                  organizationId,
                  clientId,
                  idempotencyKey: payload.idempotencyKey,
                },
                select: renderBatchSelect,
              });
            },
          );

          if (existingBatch) {
            const source = payload.source;
            let resolvedPostIds: string[];
            if (source.type === "POSTS_SELECTION") {
              resolvedPostIds = source.postIds;
            } else {
              const contentBatchId = source.contentBatchId;
              const posts = await access(
                req,
                ["OWNER", "ADMIN", "EDITOR"],
                async (tx) => {
                  return tx.post.findMany({
                    where: {
                      organizationId,
                      clientId,
                      batchId: contentBatchId,
                    },
                    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                    select: { id: true },
                  });
                },
              );
              resolvedPostIds = posts.map((p) => p.id);
            }

            const expectedHash = computeBatchRequestFingerprint({
              organizationId,
              clientId,
              templateVersionId: payload.templateVersionId,
              format: payload.format,
              sourceType: payload.source.type,
              resolvedPostIds,
              defaults: payload.defaults,
            });

            if (existingBatch.requestHash === expectedHash) {
              result = { batch: existingBatch, jobs: [], isReplay: true };
            } else {
              throw new RenderBatchError(
                409,
                "Conflito de idempotência: a chave já foi utilizada com outros parâmetros.",
              );
            }
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }

      if (result.isReplay) {
        res.status(200).json(toRenderBatchDto(result.batch));
        return;
      }

      // Enfileirar jobs no BullMQ com jobId determinístico
      let enqueueFailed = false;
      for (const job of result.jobs) {
        const queueJobId = getRenderQueueJobId(job.id);
        try {
          await renderQueue.add(
            "render-artwork",
            {
              renderJobId: job.id,
              organizationId,
              clientId,
              batchId: result.batch.id,
            },
            {
              jobId: queueJobId,
            },
          );
        } catch (queueError) {
          enqueueFailed = true;
          console.error(
            JSON.stringify({
              event: "render_batch_enqueue_failed",
              batchId: result.batch.id,
              renderJobId: job.id,
              organizationId,
              clientId,
              errorCode: "QUEUE_ENQUEUE_ERROR",
              error: sanitizeErrorMessage(queueError),
            }),
          );
        }
      }

      if (enqueueFailed) {
        res.status(202).json(toRenderBatchDto(result.batch));
        return;
      }

      res.status(201).json(toRenderBatchDto(result.batch));
    }),
  );

  // 3. Listagem de lotes
  server.get(
    root,
    handler(async (req, res) => {
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");

      const queryParse = renderBatchListQuerySchema.safeParse(req.query);
      if (!queryParse.success) {
        throw new RenderBatchError(
          400,
          "Parâmetros de consulta de lotes inválidos.",
        );
      }
      const { limit, cursor, status } = queryParse.data;

      const result = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR", "APPROVER", "CLIENT_VIEWER"],
        async (tx) => {
          const whereClause: Prisma.RenderBatchWhereInput = {
            organizationId,
            clientId,
            ...(status ? { status } : {}),
          };

          const items = await tx.renderBatch.findMany({
            where: whereClause,
            take: limit + 1,
            cursor: cursor ? { id: cursor } : undefined,
            skip: cursor ? 1 : 0,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: renderBatchSelect,
          });

          let nextCursor: string | null = null;
          if (items.length > limit) {
            const nextItem = items.pop();
            nextCursor = nextItem ? nextItem.id : null;
          }

          return {
            batches: items.map(toRenderBatchDto),
            nextCursor,
          };
        },
      );

      res.status(200).json(result);
    }),
  );

  // 4. Detalhes de um lote
  server.get(
    `${root}/:batchId`,
    handler(async (req, res) => {
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");
      const batchId = param(req, "batchId");

      const batch = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR", "APPROVER", "CLIENT_VIEWER"],
        async (tx) => {
          const found = await tx.renderBatch.findFirst({
            where: {
              id: batchId,
              organizationId,
              clientId,
            },
            select: renderBatchSelect,
          });
          if (!found) {
            throw new RenderBatchError(
              404,
              "Lote de renderização não encontrado.",
            );
          }
          return found;
        },
      );

      res.status(200).json(toRenderBatchDto(batch));
    }),
  );

  // 5. Itens de um lote
  server.get(
    `${root}/:batchId/items`,
    handler(async (req, res) => {
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");
      const batchId = param(req, "batchId");

      const queryParse = renderBatchItemsQuerySchema.safeParse(req.query);
      if (!queryParse.success) {
        throw new RenderBatchError(
          400,
          "Parâmetros de consulta de itens de lote inválidos.",
        );
      }
      const { limit, cursor, status } = queryParse.data;

      const result = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR", "APPROVER", "CLIENT_VIEWER"],
        async (tx) => {
          const batch = await tx.renderBatch.findFirst({
            where: {
              id: batchId,
              organizationId,
              clientId,
            },
          });
          if (!batch) {
            throw new RenderBatchError(
              404,
              "Lote de renderização não encontrado.",
            );
          }

          const whereClause: Prisma.RenderJobWhereInput = {
            organizationId,
            clientId,
            batchId,
            ...(status ? { status } : {}),
          };

          const jobs = await tx.renderJob.findMany({
            where: whereClause,
            take: limit + 1,
            cursor: cursor ? { id: cursor } : undefined,
            skip: cursor ? 1 : 0,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: renderJobSelect,
          });

          let nextCursor: string | null = null;
          if (jobs.length > limit) {
            const nextItem = jobs.pop();
            nextCursor = nextItem ? nextItem.id : null;
          }

          return {
            items: jobs.map(toRenderJobDto),
            nextCursor,
          };
        },
      );

      res.status(200).json(result);
    }),
  );

  // 6. Cancelamento cooperativo de lote
  server.post(
    `${root}/:batchId/cancel`,
    handler(async (req, res) => {
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");
      const batchId = param(req, "batchId");

      const updatedBatch = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR"],
        async (tx) => {
          const batch = await tx.renderBatch.findFirst({
            where: {
              id: batchId,
              organizationId,
              clientId,
            },
            select: renderBatchSelect,
          });

          if (!batch) {
            throw new RenderBatchError(
              404,
              "Lote de renderização não encontrado.",
            );
          }

          // Se já for terminal, cancelamento é idempotente e retorna o estado atual
          if (
            batch.status === "COMPLETED" ||
            batch.status === "PARTIALLY_FAILED" ||
            batch.status === "FAILED" ||
            batch.status === "CANCELLED"
          ) {
            return batch;
          }

          const now = new Date();

          // 1. Marca cancelRequestedAt no lote
          await tx.renderBatch.update({
            where: { id: batch.id },
            data: {
              cancelRequestedAt: batch.cancelRequestedAt ?? now,
            },
          });

          // 2. Cancelar atomicamente todos os jobs em PENDING deste lote
          await tx.renderJob.updateMany({
            where: {
              organizationId,
              clientId,
              batchId,
              status: "PENDING",
            },
            data: {
              status: "CANCELLED",
            },
          });

          // 3. Derivar contadores reais para eliminar perda de incremento
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
              where: {
                organizationId,
                clientId,
                batchId,
                status: "PROCESSING",
              },
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

          const isTerminal = processingItems === 0 && pendingItems === 0;
          const newStatus = computeBatchAggregateStatus({
            totalItems: batch.totalItems,
            pendingItems,
            processingItems,
            completedItems,
            failedItems,
            cancelledItems,
            cancelRequestedAt: batch.cancelRequestedAt ?? now,
          });

          // Atualizar contadores no banco através de contexto do renderer
          await tx.$executeRaw`
            SELECT set_config('app.user_id', 'system:renderer', true),
                   set_config('app.renderer_org_id', ${organizationId}, true),
                   set_config('app.renderer_client_id', ${clientId}, true)
          `;

          const updated = await tx.renderBatch.update({
            where: { id: batch.id },
            data: {
              status: newStatus,
              pendingItems,
              processingItems,
              completedItems,
              failedItems,
              cancelledItems,
              cancelCompletedAt: isTerminal ? now : null,
              completedAt: isTerminal && newStatus !== "CANCELLED" ? now : null,
            },
            select: renderBatchSelect,
          });

          await tx.auditLog.create({
            data: {
              organizationId,
              actorUserId: "system:renderer",
              entityId: batch.id,
              action: isTerminal
                ? newStatus === "CANCELLED"
                  ? "batch.cancelled"
                  : "batch.completed"
                : "batch.cancel_requested",
            },
          });

          return updated;
        },
      );

      res.status(200).json(toRenderBatchDto(updatedBatch));
    }),
  );

  // 7. Repetir somente itens falhos do lote
  server.post(
    `${root}/:batchId/retry-failed`,
    handler(async (req, res) => {
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");
      const batchId = param(req, "batchId");

      const parseResult = renderBatchRetryFailedSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new RenderBatchError(
          400,
          "Chave de idempotência para repetição inválida.",
        );
      }
      const payload: RenderBatchRetryFailed = parseResult.data;

      type RetryResult = {
        batch: {
          id: string;
          organizationId: string;
          clientId: string;
          templateVersionId: string;
          sourceType: RenderBatchSourceType;
          contentBatchId: string | null;
          parentBatchId: string | null;
          format: DesignFormat;
          status: RenderBatchStatus;
          requestHash: string;
          totalItems: number;
          pendingItems: number;
          processingItems: number;
          completedItems: number;
          failedItems: number;
          cancelledItems: number;
          idempotencyKey: string;
          cancelRequestedAt: Date | null;
          cancelCompletedAt: Date | null;
          createdById: string;
          createdAt: Date;
          updatedAt: Date;
          completedAt: Date | null;
        };
        jobs: Array<{
          id: string;
          organizationId: string;
          clientId: string;
          batchId: string | null;
        }>;
        isReplay: boolean;
      };

      let result: RetryResult;

      try {
        result = await access(
          req,
          ["OWNER", "ADMIN", "EDITOR"],
          async (tx, userId) => {
            const originalBatch = await tx.renderBatch.findFirst({
              where: { id: batchId, organizationId, clientId },
              select: renderBatchSelect,
            });

            if (!originalBatch) {
              throw new RenderBatchError(404, "Lote original não encontrado.");
            }

            if (originalBatch.status === "CANCELLING") {
              throw new RenderBatchError(
                400,
                "Não é possível repetir itens de um lote com cancelamento em andamento.",
              );
            }

            // Checagem de idempotência para o lote derivado
            const existingRetry = await tx.renderBatch.findFirst({
              where: {
                organizationId,
                clientId,
                idempotencyKey: payload.idempotencyKey,
              },
              select: renderBatchSelect,
            });

            if (existingRetry) {
              if (existingRetry.parentBatchId === originalBatch.id) {
                return { batch: existingRetry, jobs: [], isReplay: true };
              }
              throw new RenderBatchError(
                409,
                "Conflito de idempotência: a chave já foi utilizada com outros parâmetros.",
              );
            }

            // Buscar os jobs em estado FAILED do lote original
            const failedJobs = await tx.renderJob.findMany({
              where: {
                organizationId,
                clientId,
                batchId: originalBatch.id,
                status: "FAILED",
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: {
                id: true,
                postId: true,
                backgroundMediaAssetId: true,
                logoMediaAssetId: true,
                input: true,
                inputHash: true,
              },
            });

            if (failedJobs.length === 0) {
              throw new RenderBatchError(
                422,
                "Não há itens falhos para repetição neste lote.",
              );
            }

            // Snapshot dos IDs dos posts para o fingerprint
            const resolvedPostIds = failedJobs
              .map((j) => j.postId)
              .filter((id): id is string => Boolean(id));

            const retryFingerprint = computeBatchRequestFingerprint({
              organizationId,
              clientId,
              templateVersionId: originalBatch.templateVersionId,
              format: originalBatch.format,
              sourceType: originalBatch.sourceType,
              resolvedPostIds,
            });

            // Criar lote derivado vinculado ao lote original via parentBatchId
            const newRetryBatch = await tx.renderBatch.create({
              data: {
                organizationId,
                clientId,
                parentBatchId: originalBatch.id,
                templateVersionId: originalBatch.templateVersionId,
                sourceType: originalBatch.sourceType,
                contentBatchId: originalBatch.contentBatchId,
                format: originalBatch.format,
                status: "PENDING",
                requestHash: retryFingerprint,
                totalItems: failedJobs.length,
                pendingItems: failedJobs.length,
                processingItems: 0,
                completedItems: 0,
                failedItems: 0,
                cancelledItems: 0,
                idempotencyKey: payload.idempotencyKey,
                createdById: userId,
              },
              select: renderBatchSelect,
            });

            // Criar novos RenderJobs para cada item falho
            const createdJobs: Array<{
              id: string;
              organizationId: string;
              clientId: string;
              batchId: string | null;
            }> = [];

            for (let idx = 0; idx < failedJobs.length; idx++) {
              const fj = failedJobs[idx];
              if (!fj) continue;
              const job = await tx.renderJob.create({
                data: {
                  organizationId,
                  clientId,
                  batchId: newRetryBatch.id,
                  templateVersionId: originalBatch.templateVersionId,
                  postId: fj.postId,
                  backgroundMediaAssetId: fj.backgroundMediaAssetId,
                  logoMediaAssetId: fj.logoMediaAssetId,
                  status: "PENDING",
                  input: fj.input as unknown as Prisma.InputJsonValue,
                  inputHash: fj.inputHash,
                  idempotencyKey: `${payload.idempotencyKey}:${idx}`,
                  createdById: userId,
                },
                select: {
                  id: true,
                  organizationId: true,
                  clientId: true,
                  batchId: true,
                },
              });
              createdJobs.push(job);
            }

            // Auditoria
            await tx.auditLog.create({
              data: {
                organizationId,
                actorUserId: userId,
                entityId: newRetryBatch.id,
                action: "batch.retried",
              },
            });

            return {
              batch: newRetryBatch,
              jobs: createdJobs,
              isReplay: false,
            };
          },
        );
      } catch (error: unknown) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "P2002"
        ) {
          const existing = await access(
            req,
            ["OWNER", "ADMIN", "EDITOR"],
            async (tx) => {
              return tx.renderBatch.findFirst({
                where: {
                  organizationId,
                  clientId,
                  idempotencyKey: payload.idempotencyKey,
                },
                select: renderBatchSelect,
              });
            },
          );

          if (existing && existing.parentBatchId === batchId) {
            result = { batch: existing, jobs: [], isReplay: true };
          } else {
            throw new RenderBatchError(
              409,
              "Conflito de idempotência: a chave já foi utilizada com outros parâmetros.",
            );
          }
        } else {
          throw error;
        }
      }

      if (result.isReplay) {
        res.status(200).json(toRenderBatchDto(result.batch));
        return;
      }

      // Enfileirar no BullMQ
      let enqueueFailed = false;
      for (const job of result.jobs) {
        const queueJobId = getRenderQueueJobId(job.id);
        try {
          await renderQueue.add(
            "render-artwork",
            {
              renderJobId: job.id,
              organizationId,
              clientId,
              batchId: result.batch.id,
            },
            { jobId: queueJobId },
          );
        } catch {
          enqueueFailed = true;
        }
      }

      if (enqueueFailed) {
        res.status(202).json(toRenderBatchDto(result.batch));
        return;
      }

      res.status(201).json(toRenderBatchDto(result.batch));
    }),
  );
}
