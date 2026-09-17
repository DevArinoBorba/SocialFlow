import express, { type Express, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@socialflow/db";
import {
  contentBatchInput,
  postInput,
  postUpdate,
  postStatusTransition,
  postStatuses,
  type PostStatus,
  MAX_CSV_SIZE_BYTES,
  type Role,
} from "@socialflow/contracts";
import {
  importPostsFromCsv,
  CsvHeaderError,
  CsvMalformedError,
  CsvRowLimitError,
  CsvSizeLimitError,
} from "./parsers/csv-importer.js";

export type Scope = <T>(
  req: Request,
  org: string,
  fn: (
    tx: Prisma.TransactionClient,
    userId: string,
    admin: boolean,
  ) => Promise<T>,
) => Promise<T>;

export class ContentError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ContentError";
  }
}

export function registerContent(server: Express, scoped: Scope) {
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
    return scoped(req, param(req, "org"), async (tx, userId, admin) => {
      const clientId = param(req, "clientId");
      const organizationId = param(req, "org");

      const client = await tx.client.findFirst({
        where: { id: clientId, organizationId, active: true },
      });
      if (!client) throw new ContentError(404, "Cliente não encontrado.");

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
          throw new ContentError(404, "Cliente não encontrado.");
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
        throw new ContentError(403, "Acesso não autorizado para o seu perfil.");
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
            : error instanceof ContentError
              ? error.status
              : 503;

        if (status !== 503) {
          res.status(status).json({
            message:
              error instanceof Error ? error.message : "Erro na requisição.",
          });
          return;
        }

        if (error instanceof CsvSizeLimitError) {
          res.status(413).json({ message: error.message });
          return;
        }
        if (
          error instanceof CsvHeaderError ||
          error instanceof CsvMalformedError ||
          error instanceof CsvRowLimitError
        ) {
          res.status(400).json({ message: error.message });
          return;
        }
        console.error(
          JSON.stringify({
            event: "content_request_failed",
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

  const batchRoot = "/api/organizations/:org/clients/:clientId/batches";
  const postRoot = "/api/organizations/:org/clients/:clientId/posts";

  // --- CONTENT BATCH ROUTES ---

  // 1. List batches
  server.get(
    batchRoot,
    handler(async (req, res) => {
      const items = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR", "APPROVER", "CLIENT_VIEWER"],
        async (tx) => {
          return tx.contentBatch.findMany({
            where: {
              organizationId: param(req, "org"),
              clientId: param(req, "clientId"),
            },
            orderBy: { createdAt: "desc" },
            take: 100,
          });
        },
      );
      res.json(items);
    }),
  );

  // 2. Create batch
  server.post(
    batchRoot,
    handler(async (req, res) => {
      const parsed = contentBatchInput.safeParse(req.body);
      if (!parsed.success) {
        throw new ContentError(
          400,
          "Informe um nome de lote válido, sem campos adicionais.",
        );
      }
      const record = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR"],
        async (tx, userId) => {
          const organizationId = param(req, "org");
          const clientId = param(req, "clientId");
          const id = randomUUID();
          const batch = await tx.contentBatch.create({
            data: {
              id,
              organizationId,
              clientId,
              name: parsed.data.name,
              sourceType: parsed.data.sourceType,
              status: "PENDING",
            },
          });
          await audit(tx, req, userId, id, "batch.created");
          return batch;
        },
      );
      res.status(201).json(record);
    }),
  );

  // 3. Detail batch
  server.get(
    `${batchRoot}/:batchId`,
    handler(async (req, res) => {
      const batchId = param(req, "batchId");
      const record = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR", "APPROVER", "CLIENT_VIEWER"],
        async (tx) => {
          const batch = await tx.contentBatch.findFirst({
            where: {
              id: batchId,
              organizationId: param(req, "org"),
              clientId: param(req, "clientId"),
            },
          });
          if (!batch) throw new ContentError(404, "Lote não encontrado.");
          return batch;
        },
      );
      res.json(record);
    }),
  );

  // 4. Import CSV into existing batch
  server.post(
    `${batchRoot}/:batchId/import`,
    handler(async (req, res) => {
      const batchId = param(req, "batchId");

      // Middleware de recepção de CSV binário/texto com limite de 2 MiB
      const rawData = await new Promise<Buffer>((resolve, reject) => {
        express.raw({
          type: ["text/csv", "application/octet-stream", "text/plain", "*/*"],
          limit: MAX_CSV_SIZE_BYTES,
          inflate: false,
        })(req, res, (error) => {
          if (error) {
            reject(
              new ContentError(
                413,
                `Arquivo CSV excede o limite máximo permitido de 2 MiB.`,
              ),
            );
          } else if (!Buffer.isBuffer(req.body)) {
            reject(new ContentError(400, "Envie os dados do arquivo CSV."));
          } else {
            resolve(req.body);
          }
        });
      });

      // Parse e validação do CSV
      const parseResult = importPostsFromCsv(rawData);

      // Persistência atômica em transação única
      const result = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR"],
        async (tx, userId) => {
          const organizationId = param(req, "org");
          const clientId = param(req, "clientId");

          const existingBatch = await tx.contentBatch.findFirst({
            where: { id: batchId, organizationId, clientId },
          });
          if (!existingBatch) {
            throw new ContentError(404, "Lote não encontrado.");
          }

          // Atualizar o lote com contagens e relatório de erros
          await tx.contentBatch.update({
            where: {
              organizationId_clientId_id: {
                organizationId,
                clientId,
                id: batchId,
              },
            },
            data: {
              status: "COMPLETED",
              totalRows: parseResult.totalRows,
              validRows: parseResult.validCount,
              invalidRows: parseResult.invalidCount,
              errorReport:
                parseResult.errors.length > 0
                  ? (parseResult.errors as unknown as Prisma.InputJsonValue)
                  : undefined,
            },
          });

          // Inserir linhas válidas como DRAFT
          if (parseResult.validRows.length > 0) {
            await tx.post.createMany({
              data: parseResult.validRows.map((row) => ({
                id: randomUUID(),
                organizationId,
                clientId,
                batchId,
                status: "DRAFT" as const,
                title: row.title,
                caption: row.caption,
                hashtags: row.hashtags,
                callToAction: row.callToAction,
                firstComment: row.firstComment,
                suggestedDate: row.suggestedDate
                  ? new Date(row.suggestedDate)
                  : null,
              })),
            });
          }

          await audit(tx, req, userId, batchId, "batch.imported");

          return {
            batchId,
            totalRows: parseResult.totalRows,
            validRows: parseResult.validCount,
            invalidRows: parseResult.invalidCount,
            errors: parseResult.errors,
          };
        },
      );

      res.status(200).json(result);
    }),
  );

  // --- POST ROUTES ---

  // 1. List posts
  server.get(
    postRoot,
    handler(async (req, res) => {
      const items = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR", "APPROVER", "CLIENT_VIEWER"],
        async (tx) => {
          const organizationId = param(req, "org");
          const clientId = param(req, "clientId");
          const batchId =
            typeof req.query.batchId === "string"
              ? req.query.batchId
              : undefined;
          const status =
            typeof req.query.status === "string" &&
            (postStatuses as readonly string[]).includes(req.query.status)
              ? (req.query.status as PostStatus)
              : undefined;

          return tx.post.findMany({
            where: {
              organizationId,
              clientId,
              ...(batchId ? { batchId } : {}),
              ...(status ? { status } : {}),
            },
            orderBy: { createdAt: "desc" },
            take: 100,
          });
        },
      );
      res.json(items);
    }),
  );

  // 2. Detail post
  server.get(
    `${postRoot}/:postId`,
    handler(async (req, res) => {
      const postId = param(req, "postId");
      const record = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR", "APPROVER", "CLIENT_VIEWER"],
        async (tx) => {
          const post = await tx.post.findFirst({
            where: {
              id: postId,
              organizationId: param(req, "org"),
              clientId: param(req, "clientId"),
            },
          });
          if (!post) throw new ContentError(404, "Post não encontrado.");
          return post;
        },
      );
      res.json(record);
    }),
  );

  // 3. Create post (single / manual)
  server.post(
    postRoot,
    handler(async (req, res) => {
      const parsed = postInput.safeParse(req.body);
      if (!parsed.success) {
        throw new ContentError(
          400,
          "Informe dados de post válidos, sem campos adicionais.",
        );
      }
      const record = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR"],
        async (tx, userId) => {
          const organizationId = param(req, "org");
          const clientId = param(req, "clientId");

          if (parsed.data.brandId) {
            const brand = await tx.brand.findFirst({
              where: {
                id: parsed.data.brandId,
                organizationId,
                clientId,
              },
            });
            if (!brand) {
              throw new ContentError(
                404,
                "Marca não encontrada neste cliente.",
              );
            }
          }

          const id = randomUUID();
          const post = await tx.post.create({
            data: {
              id,
              organizationId,
              clientId,
              status: "DRAFT",
              title: parsed.data.title,
              caption: parsed.data.caption,
              hashtags: parsed.data.hashtags,
              callToAction: parsed.data.callToAction,
              firstComment: parsed.data.firstComment,
              suggestedDate: parsed.data.suggestedDate
                ? new Date(parsed.data.suggestedDate)
                : null,
              brandId: parsed.data.brandId,
            },
          });

          await audit(tx, req, userId, id, "post.created");
          return post;
        },
      );
      res.status(201).json(record);
    }),
  );

  // 4. Update post content
  server.patch(
    `${postRoot}/:postId`,
    handler(async (req, res) => {
      const postId = param(req, "postId");
      const parsed = postUpdate.safeParse(req.body);
      if (!parsed.success) {
        throw new ContentError(
          400,
          "Informe dados de post válidos, sem campos adicionais.",
        );
      }

      const record = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR"],
        async (tx, userId, role, admin) => {
          const organizationId = param(req, "org");
          const clientId = param(req, "clientId");

          const post = await tx.post.findFirst({
            where: { id: postId, organizationId, clientId },
          });
          if (!post) throw new ContentError(404, "Post não encontrado.");

          // EDITOR só pode editar posts em DRAFT ou REJECTED
          if (
            !admin &&
            role === "EDITOR" &&
            post.status !== "DRAFT" &&
            post.status !== "REJECTED"
          ) {
            throw new ContentError(
              403,
              "Não é possível editar post em revisão ou já aprovado.",
            );
          }

          if (parsed.data.brandId) {
            const brand = await tx.brand.findFirst({
              where: {
                id: parsed.data.brandId,
                organizationId,
                clientId,
              },
            });
            if (!brand) {
              throw new ContentError(
                404,
                "Marca não encontrada neste cliente.",
              );
            }
          }

          const updated = await tx.post.update({
            where: {
              organizationId_clientId_id: {
                organizationId,
                clientId,
                id: postId,
              },
            },
            data: {
              title: parsed.data.title,
              caption: parsed.data.caption,
              hashtags: parsed.data.hashtags,
              callToAction: parsed.data.callToAction,
              firstComment: parsed.data.firstComment,
              suggestedDate: parsed.data.suggestedDate
                ? new Date(parsed.data.suggestedDate)
                : null,
              brandId: parsed.data.brandId,
            },
          });

          await audit(tx, req, userId, postId, "post.updated");
          return updated;
        },
      );
      res.json(record);
    }),
  );

  // 5. Update post status (Workflow & Approval State Machine)
  server.patch(
    `${postRoot}/:postId/status`,
    handler(async (req, res) => {
      const postId = param(req, "postId");
      const parsed = postStatusTransition.safeParse(req.body);
      if (!parsed.success) {
        throw new ContentError(
          400,
          "Informe um status válido para a transição.",
        );
      }

      const targetStatus = parsed.data.status;
      const rejectionReason = parsed.data.rejectionReason?.trim() || null;

      const record = await access(
        req,
        ["OWNER", "ADMIN", "EDITOR", "APPROVER"],
        async (tx, userId, role, admin) => {
          const organizationId = param(req, "org");
          const clientId = param(req, "clientId");

          const post = await tx.post.findFirst({
            where: { id: postId, organizationId, clientId },
          });
          if (!post) throw new ContentError(404, "Post não encontrado.");

          const currentStatus = post.status;

          // Regras da Máquina de Estados e RBAC
          if (targetStatus === "IN_REVIEW") {
            if (role === "APPROVER" && !admin) {
              throw new ContentError(
                403,
                "Aprovador não submete posts para revisão.",
              );
            }
            if (currentStatus !== "DRAFT" && currentStatus !== "REJECTED") {
              throw new ContentError(
                400,
                "Apenas posts em rascunho ou rejeitados podem ser enviados para revisão.",
              );
            }
          } else if (targetStatus === "APPROVED") {
            if (role === "EDITOR" && !admin) {
              throw new ContentError(403, "Seu perfil não pode aprovar posts.");
            }
            if (currentStatus !== "IN_REVIEW") {
              throw new ContentError(
                400,
                "Apenas posts em revisão podem ser aprovados.",
              );
            }
          } else if (targetStatus === "REJECTED") {
            if (role === "EDITOR" && !admin) {
              throw new ContentError(
                403,
                "Seu perfil não pode rejeitar posts.",
              );
            }
            if (currentStatus !== "IN_REVIEW") {
              throw new ContentError(
                400,
                "Apenas posts em revisão podem ser rejeitados.",
              );
            }
            if (!rejectionReason) {
              throw new ContentError(
                400,
                "Justificativa de rejeição é obrigatória.",
              );
            }
          } else if (targetStatus === "DRAFT") {
            if (
              role !== "OWNER" &&
              role !== "ADMIN" &&
              currentStatus !== "REJECTED"
            ) {
              throw new ContentError(
                400,
                "Transição para rascunho permitida apenas para posts rejeitados.",
              );
            }
          } else {
            throw new ContentError(400, "Transição de status inválida.");
          }

          const updated = await tx.post.update({
            where: {
              organizationId_clientId_id: {
                organizationId,
                clientId,
                id: postId,
              },
            },
            data: {
              status: targetStatus,
              rejectionReason:
                targetStatus === "REJECTED" ? rejectionReason : null,
            },
          });

          await audit(tx, req, userId, postId, "post.status_changed");
          return updated;
        },
      );

      res.json(record);
    }),
  );
}
