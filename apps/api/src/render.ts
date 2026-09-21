import type { Express, Request, Response } from "express";
import type { Queue } from "bullmq";
import type { Prisma, RenderJobStatus } from "@socialflow/db";
import {
  type Role,
  renderRequestSchema,
  artworkInputSchema,
  designTemplateSpecSchema,
  type RenderRequest,
  type ArtworkInput,
} from "@socialflow/contracts";
import { hashRenderInput, RENDERER_VERSION } from "@socialflow/render";
import { getRenderQueueJobId, type RenderJobData } from "./render-queue.js";
import { z } from "zod";

export type Scope = <T>(
  req: Request,
  org: string,
  fn: (
    tx: Prisma.TransactionClient,
    userId: string,
    admin: boolean,
  ) => Promise<T>,
) => Promise<T>;

export class RenderError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RenderError";
  }
}

export interface RenderJobDto {
  id: string;
  status: RenderJobStatus;
  templateVersionId: string;
  postId: string | null;
  backgroundMediaAssetId: string | null;
  logoMediaAssetId: string | null;
  outputMediaAssetId: string | null;
  outputMediaUrl: string | null;
  attemptNumber: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export function toRenderJobDto(job: {
  id: string;
  organizationId: string;
  clientId: string;
  status: RenderJobStatus;
  templateVersionId: string;
  postId: string | null;
  backgroundMediaAssetId: string | null;
  logoMediaAssetId: string | null;
  outputMediaAssetId: string | null;
  attemptNumber: number;
  errorCode: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
}): RenderJobDto {
  const outputMediaUrl = job.outputMediaAssetId
    ? `/api/organizations/${job.organizationId}/clients/${job.clientId}/media/${job.outputMediaAssetId}`
    : null;

  return {
    id: job.id,
    status: job.status,
    templateVersionId: job.templateVersionId,
    postId: job.postId,
    backgroundMediaAssetId: job.backgroundMediaAssetId,
    logoMediaAssetId: job.logoMediaAssetId,
    outputMediaAssetId: job.outputMediaAssetId,
    outputMediaUrl,
    attemptNumber: job.attemptNumber,
    errorCode: job.errorCode,
    createdAt:
      job.createdAt instanceof Date
        ? job.createdAt.toISOString()
        : String(job.createdAt),
    updatedAt:
      job.updatedAt instanceof Date
        ? job.updatedAt.toISOString()
        : String(job.updatedAt),
    completedAt: job.completedAt
      ? job.completedAt instanceof Date
        ? job.completedAt.toISOString()
        : String(job.completedAt)
      : null,
  };
}

const listQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  cursor: z.string().uuid().optional(),
  status: z.enum(["PENDING", "PROCESSING", "COMPLETED", "FAILED"]).optional(),
});

const disallowedContentPattern =
  /<[a-zA-Z/][^>]*>|(?:https?|ftp|file|javascript|data):|(?:url\(|@import|expression\()/i;

function validateArtworkInputText(input: ArtworkInput) {
  const fieldsToCheck = [
    input.title,
    input.eyebrow,
    input.subtitle,
    input.callToAction,
  ].filter(Boolean);

  for (const text of fieldsToCheck) {
    if (disallowedContentPattern.test(text)) {
      throw new RenderError(
        400,
        "Entrada contém conteúdo não permitido (HTML, CSS, URLs ou scripts).",
      );
    }
  }
}

const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SHA256_HEX_REGEX = /^[0-9a-fA-F]{64}$/;

function validateMediaAssetRecord(
  asset: {
    status: string;
    archived: boolean;
    mimeType: string | null;
    byteSize: number | null;
    sha256: string | null;
  },
  label: string,
) {
  if (asset.status !== "ready") {
    throw new RenderError(400, `${label} ainda não está pronta para uso.`);
  }
  if (asset.archived) {
    throw new RenderError(400, `${label} está arquivada.`);
  }
  if (!asset.mimeType || !ALLOWED_IMAGE_MIMES.includes(asset.mimeType)) {
    throw new RenderError(400, `MIME type de ${label} inválido.`);
  }
  if (
    !asset.byteSize ||
    asset.byteSize <= 0 ||
    asset.byteSize > MAX_IMAGE_BYTES
  ) {
    throw new RenderError(400, `Tamanho de ${label} inválido.`);
  }
  if (!asset.sha256 || !SHA256_HEX_REGEX.test(asset.sha256)) {
    throw new RenderError(400, `SHA-256 de ${label} inválido.`);
  }
}

export function registerRender(
  server: Express,
  scoped: Scope,
  renderQueue: Queue<RenderJobData>,
) {
  const orgParam = (req: Request) =>
    String(req.params.organizationId ?? req.params.org);
  const clientParam = (req: Request) => String(req.params.clientId);

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
    const organizationId = orgParam(req);
    const clientId = clientParam(req);

    return scoped(req, organizationId, async (tx, userId, admin) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, organizationId, active: true },
      });
      if (!client) throw new RenderError(404, "Cliente não encontrado.");

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
          throw new RenderError(404, "Cliente não encontrado.");
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
        throw new RenderError(403, "Acesso não autorizado para o seu perfil.");
      }

      return fn(tx, userId, effectiveRole, admin);
    });
  }

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
            : error instanceof RenderError
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
            event: "render_request_failed",
            error: error instanceof Error ? error.message : String(error),
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
    inputHash: true,
    attemptNumber: true,
    errorCode: true,
    createdAt: true,
    updatedAt: true,
    completedAt: true,
  } as const;

  function matchesPayload(
    existing: {
      templateVersionId: string;
      postId: string | null;
      backgroundMediaAssetId: string | null;
      logoMediaAssetId: string | null;
      inputHash: string;
    },
    payload: RenderRequest,
    inputHash: string,
  ): boolean {
    return (
      existing.templateVersionId === payload.templateVersionId &&
      existing.postId === (payload.postId ?? null) &&
      existing.backgroundMediaAssetId ===
        (payload.input.backgroundMediaAssetId ?? null) &&
      existing.logoMediaAssetId === (payload.input.logoMediaAssetId ?? null) &&
      existing.inputHash === inputHash
    );
  }

  const routes = [
    "/api/organizations/:organizationId/clients/:clientId/render-jobs",
    "/api/organizations/:org/clients/:clientId/render-jobs",
  ];

  for (const root of routes) {
    // 1. Criar solicitação de renderização
    server.post(
      root,
      handler(async (req, res) => {
        const organizationId = orgParam(req);
        const clientId = clientParam(req);

        // Validação estrita do payload (rejeita campos desconhecidos)
        const parseResult = renderRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          throw new RenderError(
            400,
            "Dados de solicitação de renderização inválidos.",
          );
        }
        const payload = parseResult.data;

        // Validar textos contra HTML/CSS/URLs/scripts
        validateArtworkInputText(payload.input);

        // RBAC: apenas OWNER, ADMIN, EDITOR podem criar
        type CreateResult = {
          job: {
            id: string;
            organizationId: string;
            clientId: string;
            status: RenderJobStatus;
            templateVersionId: string;
            postId: string | null;
            backgroundMediaAssetId: string | null;
            logoMediaAssetId: string | null;
            outputMediaAssetId: string | null;
            inputHash: string;
            attemptNumber: number;
            errorCode: string | null;
            createdAt: Date;
            updatedAt: Date;
            completedAt: Date | null;
          };
          isReplay: boolean;
        };

        let result: CreateResult;

        try {
          result = await access(
            req,
            ["OWNER", "ADMIN", "EDITOR"],
            async (tx, userId) => {
              // 2. Confirmar DesignTemplateVersion no mesmo tenant
              const templateVersion = await tx.designTemplateVersion.findFirst({
                where: {
                  id: payload.templateVersionId,
                  organizationId,
                  clientId,
                },
                include: {
                  template: true,
                },
              });

              if (!templateVersion) {
                throw new RenderError(
                  404,
                  "Template de design não encontrado.",
                );
              }

              // 3. Confirmar que o DesignTemplate está ACTIVE
              if (templateVersion.template.status !== "ACTIVE") {
                throw new RenderError(
                  400,
                  "O template de design selecionado não está ativo.",
                );
              }

              // 4. Confirmar que rendererVersion é exatamente a suportada por @socialflow/render
              if (templateVersion.rendererVersion !== RENDERER_VERSION) {
                throw new RenderError(
                  400,
                  "Versão do renderizador incompatível com este template.",
                );
              }

              // 5. Validar novamente a especificação com designTemplateSpecSchema
              const specParse = designTemplateSpecSchema.safeParse(
                templateVersion.spec,
              );
              if (!specParse.success) {
                throw new RenderError(
                  400,
                  "Especificação técnica do template é inválida.",
                );
              }
              const spec = specParse.data;

              // 6. Validar o input com artworkInputSchema
              const inputParse = artworkInputSchema.safeParse(payload.input);
              if (!inputParse.success) {
                throw new RenderError(
                  400,
                  "Dados de entrada da arte são inválidos.",
                );
              }
              const input = inputParse.data;

              // 7. Se houver postId, confirmar que pertence ao mesmo cliente
              if (payload.postId) {
                const post = await tx.post.findFirst({
                  where: {
                    id: payload.postId,
                    organizationId,
                    clientId,
                  },
                });
                if (!post) {
                  throw new RenderError(
                    404,
                    "Publicação associada não encontrada no cliente.",
                  );
                }
              }

              // 8. Confirmar que background e logotipo:
              // - pertencem ao mesmo tenant;
              // - estão ready;
              // - não estão arquivados;
              // - possuem MIME, tamanho e SHA-256 válidos.
              if (input.backgroundMediaAssetId) {
                const bgAsset = await tx.mediaAsset.findFirst({
                  where: {
                    id: input.backgroundMediaAssetId,
                    organizationId,
                    clientId,
                  },
                });
                if (!bgAsset) {
                  throw new RenderError(
                    400,
                    "Imagem de fundo não encontrada ou inválida.",
                  );
                }
                validateMediaAssetRecord(bgAsset, "Imagem de fundo");
              }

              if (input.logoMediaAssetId) {
                const logoAsset = await tx.mediaAsset.findFirst({
                  where: {
                    id: input.logoMediaAssetId,
                    organizationId,
                    clientId,
                  },
                });
                if (!logoAsset) {
                  throw new RenderError(
                    400,
                    "Logotipo não encontrado ou inválido.",
                  );
                }
                validateMediaAssetRecord(logoAsset, "Logotipo");
              }

              // 9. Calcular inputHash
              const inputHash = hashRenderInput(spec, input);

              // Idempotência durável: verificar se já existe registro com a chave
              const existing = await tx.renderJob.findFirst({
                where: {
                  organizationId,
                  clientId,
                  idempotencyKey: payload.idempotencyKey,
                },
                select: renderJobSelect,
              });

              if (existing) {
                if (matchesPayload(existing, payload, inputHash)) {
                  return { job: existing, isReplay: true };
                }
                throw new RenderError(
                  409,
                  "Conflito de idempotência: a chave já foi utilizada com outros parâmetros.",
                );
              }

              // Criar novo RenderJob em PENDING
              const newJob = await tx.renderJob.create({
                data: {
                  organizationId,
                  clientId,
                  templateVersionId: payload.templateVersionId,
                  postId: payload.postId ?? null,
                  backgroundMediaAssetId: input.backgroundMediaAssetId ?? null,
                  logoMediaAssetId: input.logoMediaAssetId ?? null,
                  status: "PENDING",
                  input: input as unknown as Prisma.InputJsonValue,
                  inputHash,
                  idempotencyKey: payload.idempotencyKey,
                  createdById: userId,
                },
                select: renderJobSelect,
              });

              // Registrar auditoria
              await tx.auditLog.create({
                data: {
                  organizationId,
                  actorUserId: userId,
                  entityId: newJob.id,
                  action: "render.requested",
                },
              });

              return { job: newJob, isReplay: false };
            },
          );
        } catch (error: unknown) {
          // Tratar concorrência onde duas requisições paralelas tentam inserir a mesma idempotencyKey
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "P2002"
          ) {
            // Resolver o conflito consultando o registro vencedor
            const existingJob = await access(
              req,
              ["OWNER", "ADMIN", "EDITOR"],
              async (tx) => {
                return tx.renderJob.findFirst({
                  where: {
                    organizationId,
                    clientId,
                    idempotencyKey: payload.idempotencyKey,
                  },
                  select: renderJobSelect,
                });
              },
            );

            if (existingJob) {
              const specVersion = await access(
                req,
                ["OWNER", "ADMIN", "EDITOR"],
                async (tx) => {
                  return tx.designTemplateVersion.findFirst({
                    where: {
                      id: payload.templateVersionId,
                      organizationId,
                      clientId,
                    },
                    select: { spec: true },
                  });
                },
              );
              const spec = specVersion
                ? designTemplateSpecSchema.parse(specVersion.spec)
                : null;
              const inputHash = spec
                ? hashRenderInput(spec, payload.input)
                : "";

              if (matchesPayload(existingJob, payload, inputHash)) {
                result = { job: existingJob, isReplay: true };
              } else {
                throw new RenderError(
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

        // Se for replay idêntico: retornar 200 OK sem reenfileirar nem gerar auditoria
        if (result.isReplay) {
          res.status(200).json(toRenderJobDto(result.job));
          return;
        }

        // Se for nova solicitação: enfileirar de forma durável
        const queueJobId = getRenderQueueJobId(result.job.id);
        try {
          await renderQueue.add(
            "render-artwork",
            {
              renderJobId: result.job.id,
              organizationId,
              clientId,
            },
            {
              jobId: queueJobId,
            },
          );
        } catch (queueError) {
          // Se queue.add() falhar:
          // - RenderJob permanece PENDING;
          // - não apagar registro;
          // - log estruturado e sanitizado;
          // - responder 202 pois a intenção já foi persistida (reconciliação reenfileirará depois).
          console.error(
            JSON.stringify({
              event: "render_enqueue_failed",
              renderJobId: result.job.id,
              organizationId,
              clientId,
              error:
                queueError instanceof Error
                  ? queueError.message
                  : String(queueError),
            }),
          );
        }

        res.status(202).json(toRenderJobDto(result.job));
      }),
    );

    // 2. Listar renderizações recentes do cliente
    server.get(
      root,
      handler(async (req, res) => {
        const organizationId = orgParam(req);
        const clientId = clientParam(req);

        const parseResult = listQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
          throw new RenderError(400, "Parâmetros de listagem inválidos.");
        }
        const { limit, cursor, status } = parseResult.data;

        const jobs = await access(
          req,
          ["OWNER", "ADMIN", "EDITOR", "APPROVER", "CLIENT_VIEWER"],
          async (tx) => {
            try {
              return await tx.renderJob.findMany({
                where: {
                  organizationId,
                  clientId,
                  ...(status ? { status } : {}),
                },
                select: renderJobSelect,
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: limit + 1,
                ...(cursor
                  ? {
                      cursor: { id: cursor },
                      skip: 1,
                    }
                  : {}),
              });
            } catch (queryErr: unknown) {
              if (
                queryErr &&
                typeof queryErr === "object" &&
                "code" in queryErr &&
                queryErr.code === "P2025"
              ) {
                throw new RenderError(
                  400,
                  "Cursor de paginação inválido ou não encontrado.",
                );
              }
              throw queryErr;
            }
          },
        );

        const hasMore = jobs.length > limit;
        const paged = hasMore ? jobs.slice(0, limit) : jobs;
        const nextCursor =
          hasMore && paged.length > 0
            ? (paged[paged.length - 1]?.id ?? null)
            : null;

        res.json({
          items: paged.map(toRenderJobDto),
          nextCursor,
          hasMore,
        });
      }),
    );

    // 3. Consultar uma renderização específica
    server.get(
      `${root}/:renderJobId`,
      handler(async (req, res) => {
        const organizationId = orgParam(req);
        const clientId = clientParam(req);
        const renderJobId = String(req.params.renderJobId);

        const job = await access(
          req,
          ["OWNER", "ADMIN", "EDITOR", "APPROVER", "CLIENT_VIEWER"],
          async (tx) => {
            return tx.renderJob.findFirst({
              where: {
                id: renderJobId,
                organizationId,
                clientId,
              },
              select: renderJobSelect,
            });
          },
        );

        if (!job) {
          throw new RenderError(404, "RenderJob não encontrado.");
        }

        res.json(toRenderJobDto(job));
      }),
    );
  }
}
