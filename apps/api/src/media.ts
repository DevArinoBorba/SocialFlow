import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import type { Prisma } from "@socialflow/db";
import {
  MAX_IMAGE_BYTES,
  mediaStorage,
  validateImage,
} from "./media-storage.js";

export type Scope = <T>(
  req: Request,
  org: string,
  fn: (
    tx: Prisma.TransactionClient,
    userId: string,
    admin: boolean,
  ) => Promise<T>,
) => Promise<T>;
export class MediaError extends Error {
  constructor(
    public status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
const input = z.strictObject({
  name: z.string().trim().min(2).max(120),
  description: z.string().max(2000).default(""),
  brandId: z.string().min(1).max(100).nullable().default(null),
});
const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  brandId: z.string().max(100).optional(),
});
const publicFields = {
  id: true,
  name: true,
  description: true,
  brandId: true,
  mimeType: true,
  byteSize: true,
  width: true,
  height: true,
  createdAt: true,
} as const;

export type MediaStorage = NonNullable<ReturnType<typeof mediaStorage>>;

export interface MediaDependencies {
  storage?: MediaStorage | null;
}

export function sanitizeClientCorrelationId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

export function registerMedia(
  server: Express,
  scoped: Scope,
  deps?: MediaDependencies,
) {
  const storage =
    deps?.storage !== undefined ? deps.storage : mediaStorage(process.env);
  const root = "/api/organizations/:org/clients/:clientId/media";
  const param = (req: Request, name: string) => String(req.params[name]);
  async function access<T>(
    req: Request,
    write: boolean,
    fn: (
      tx: Prisma.TransactionClient,
      userId: string,
      admin: boolean,
    ) => Promise<T>,
  ) {
    return scoped(req, param(req, "org"), async (tx, userId, admin) => {
      const clientId = param(req, "clientId");
      const organizationId = param(req, "org");
      if (
        !(await tx.client.findFirst({
          where: { id: clientId, organizationId, active: true },
        }))
      )
        throw new MediaError(404, "Cliente não encontrado.");
      if (!admin) {
        const clientMembership = await tx.membership.findFirst({
          where: {
            userId,
            organizationId,
            clientId,
            active: true,
          },
        });
        if (!clientMembership)
          throw new MediaError(404, "Cliente não encontrado.");
        if (write && clientMembership.role !== "EDITOR")
          throw new MediaError(403, "Seu perfil não pode editar imagens.");
      }
      return fn(tx, userId, admin);
    });
  }
  const where = (req: Request) => ({
    organizationId: param(req, "org"),
    clientId: param(req, "clientId"),
    id: param(req, "id"),
    archived: false,
  });
  const audit = (
    tx: Prisma.TransactionClient,
    req: Request,
    userId: string,
    id: string,
    action: string,
  ) =>
    tx.auditLog.create({
      data: {
        organizationId: param(req, "org"),
        actorUserId: userId,
        entityId: id,
        action,
      },
    });
  async function brand(
    tx: Prisma.TransactionClient,
    req: Request,
    brandId: string | null,
  ) {
    if (
      brandId &&
      !(await tx.brand.findFirst({
        where: {
          id: brandId,
          organizationId: param(req, "org"),
          clientId: param(req, "clientId"),
        },
      }))
    )
      throw new MediaError(404, "Marca não encontrada neste cliente.");
  }
  function handler(fn: (req: Request, res: Response) => Promise<unknown>) {
    return async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (error) {
        const status =
          error instanceof Error &&
          "status" in error &&
          typeof error.status === "number"
            ? error.status
            : 503;
        if (status === 503)
          console.error(JSON.stringify({ event: "media_request_failed" }));
        if (!res.headersSent)
          res.status(status).json({
            message:
              status === 503
                ? "Não foi possível concluir. Tente novamente."
                : (error as Error).message,
          });
      }
    };
  }
  server.get(
    root,
    handler(async (req, res) => {
      const query = listQuery.safeParse(req.query);
      if (!query.success) throw new MediaError(400, "Filtro inválido.");
      const items = await access(req, false, async (tx) => {
        if (query.data.brandId) await brand(tx, req, query.data.brandId);
        return tx.mediaAsset.findMany({
          where: {
            organizationId: param(req, "org"),
            clientId: param(req, "clientId"),
            status: "ready",
            archived: false,
            ...(query.data.brandId ? { brandId: query.data.brandId } : {}),
          },
          select: publicFields,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (query.data.page - 1) * 24,
          take: 25,
        });
      });
      res.json({
        items: items.slice(0, 24),
        hasMore: items.length > 24,
        available: !!storage,
      });
    }),
  );
  server.post(
    root,
    handler(async (req, res) => {
      if (!storage) throw new MediaError(503, "Armazenamento indisponível.");
      const parsed = input.safeParse(req.body);
      if (!parsed.success)
        throw new MediaError(400, "Informe nome, descrição e marca válidos.");
      const record = await access(req, true, async (tx, userId) => {
        await brand(tx, req, parsed.data.brandId);
        const organizationId = param(req, "org"),
          clientId = param(req, "clientId");
        // Bound abandoned upload reservations without deleting any object.
        if (
          (await tx.mediaAsset.count({
            where: {
              organizationId,
              clientId,
              status: { in: ["pending", "uploading"] },
              createdAt: { gt: new Date(Date.now() - 3600000) },
            },
          })) >= 20
        )
          throw new MediaError(
            429,
            "Muitos envios pendentes. Tente novamente mais tarde.",
          );
        const id = randomUUID();
        await tx.mediaAsset.create({
          data: {
            id,
            organizationId,
            clientId,
            ...parsed.data,
            storageKey: `media/${organizationId}/${clientId}/${id}`,
          },
        });
        await audit(tx, req, userId, id, "media.upload_requested");
        return { id };
      });
      res.status(201).json(record);
    }),
  );
  let uploads = 0;
  server.put(
    `${root}/:id/content`,
    handler(async (req, res) => {
      // Reutiliza o identificador gerado pelo servidor (X-Request-Id) ou gera UUID aleatório v4
      const internalCorrelationId =
        (res.getHeader("X-Request-Id") as string) ||
        (res.getHeader("x-request-id") as string) ||
        randomUUID();
      // Identificador de correlação externo fornecido pelo cliente é validado e mantido separado
      const clientCorrelationId = sanitizeClientCorrelationId(
        req.headers["x-correlation-id"],
      );
      await access(req, true, async (tx) => {
        const asset = await tx.mediaAsset.findFirst({ where: where(req) });
        if (!asset) throw new MediaError(404, "Imagem não encontrada.");
        if (asset.status !== "pending")
          throw new MediaError(
            409,
            "Este envio já foi processado. Atualize a biblioteca.",
          );
      });
      if (!storage) throw new MediaError(503, "Armazenamento indisponível.");
      if (uploads >= 2)
        throw new MediaError(
          429,
          "Há outros envios em andamento. Tente novamente.",
        );
      uploads++;
      try {
        const data = await new Promise<Buffer>((resolve, reject) => {
          express.raw({
            type: "application/octet-stream",
            limit: MAX_IMAGE_BYTES,
            inflate: false,
          })(req, res, (error) => {
            if (error)
              reject(new MediaError(413, "Envie uma imagem de até 10 MB."));
            else if (!Buffer.isBuffer(req.body))
              reject(new MediaError(400, "Envie os bytes da imagem."));
            else resolve(req.body);
          });
        });
        let validated: Awaited<ReturnType<typeof validateImage>>;
        try {
          validated = await validateImage(data);
        } catch {
          throw new MediaError(
            400,
            "Imagem inválida. Use JPEG, PNG ou WebP estático, até 10 MB e 25 megapixels.",
          );
        }
        const asset = await access(req, true, async (tx, userId) => {
          const claimed = await tx.mediaAsset.updateMany({
            where: {
              ...where(req),
              status: "pending",
              createdAt: { gt: new Date(Date.now() - 3600000) },
            },
            data: { status: "uploading" },
          });
          if (!claimed.count)
            throw new MediaError(
              409,
              "Envio expirado ou já processado. Inicie um novo envio.",
            );
          await audit(
            tx,
            req,
            userId,
            param(req, "id"),
            "media.upload_started",
          );
          return tx.mediaAsset.findFirstOrThrow({ where: where(req) });
        });

        // Stage 1: storage.put
        try {
          await storage.put(
            asset.storageKey,
            validated.data,
            validated.mimeType,
          );
        } catch (storageError) {
          console.error(
            JSON.stringify({
              event: "media_upload_failed",
              stage: "storage_put",
              organizationId: param(req, "org"),
              clientId: param(req, "clientId"),
              assetId: param(req, "id"),
              correlationId: internalCorrelationId,
              ...(clientCorrelationId ? { clientCorrelationId } : {}),
            }),
          );
          let markedFailed = false;
          try {
            await access(req, true, async (tx, userId) => {
              const updated = await tx.mediaAsset.updateMany({
                where: { ...where(req), status: "uploading" },
                data: { status: "failed" },
              });
              if (updated.count > 0) {
                await audit(
                  tx,
                  req,
                  userId,
                  param(req, "id"),
                  "media.upload_failed",
                );
                markedFailed = true;
              }
            });
          } catch {
            // best-effort reconciliation
          }
          if (!markedFailed) {
            console.warn(
              JSON.stringify({
                event: "media_reconciliation_needed",
                organizationId: param(req, "org"),
                clientId: param(req, "clientId"),
                assetId: param(req, "id"),
                storageKey: asset.storageKey,
                status: "uploading",
                correlationId: internalCorrelationId,
                ...(clientCorrelationId ? { clientCorrelationId } : {}),
              }),
            );
          }
          throw new MediaError(
            503,
            "Falha ao gravar imagem no armazenamento.",
            { cause: storageError },
          );
        }

        // Stage 2: database_commit
        let result;
        try {
          result = await access(req, true, async (tx, userId) => {
            const { data: bytes, ...metadata } = validated;
            void bytes;
            const updated = await tx.mediaAsset.updateMany({
              where: { ...where(req), status: "uploading" },
              data: { ...metadata, status: "ready" },
            });
            if (!updated.count)
              throw new MediaError(409, "Envio indisponível.");
            await audit(tx, req, userId, asset.id, "media.created");
            return tx.mediaAsset.findFirstOrThrow({
              where: where(req),
              select: publicFields,
            });
          });
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "media_upload_failed",
              stage: "database_commit",
              organizationId: param(req, "org"),
              clientId: param(req, "clientId"),
              assetId: param(req, "id"),
              correlationId: internalCorrelationId,
              ...(clientCorrelationId ? { clientCorrelationId } : {}),
            }),
          );
          let markedFailed = false;
          try {
            await access(req, true, async (tx, userId) => {
              const updated = await tx.mediaAsset.updateMany({
                where: { ...where(req), status: "uploading" },
                data: { status: "failed" },
              });
              if (updated.count > 0) {
                await audit(
                  tx,
                  req,
                  userId,
                  param(req, "id"),
                  "media.upload_failed",
                );
                markedFailed = true;
              }
            });
          } catch {
            // caller's authorization revoked or database down
          }
          if (!markedFailed) {
            console.warn(
              JSON.stringify({
                event: "media_reconciliation_needed",
                organizationId: param(req, "org"),
                clientId: param(req, "clientId"),
                assetId: param(req, "id"),
                storageKey: asset.storageKey,
                status: "uploading",
                correlationId: internalCorrelationId,
                ...(clientCorrelationId ? { clientCorrelationId } : {}),
              }),
            );
          }
          if (
            error instanceof Error &&
            "status" in error &&
            typeof (error as { status: unknown }).status === "number"
          ) {
            throw error;
          }
          throw new MediaError(503, "Falha ao finalizar envio da imagem.", {
            cause: error,
          });
        }
        res.status(201).json(result);
      } finally {
        uploads--;
      }
    }),
  );
  server.get(
    `${root}/:id/content`,
    handler(async (req, res) => {
      const asset = await access(req, false, (tx) =>
        tx.mediaAsset.findFirst({ where: { ...where(req), status: "ready" } }),
      );
      if (!asset) throw new MediaError(404, "Imagem não encontrada.");
      if (!storage) throw new MediaError(503, "Armazenamento indisponível.");
      const bytes = await storage.get(asset.storageKey);
      if (
        bytes.length !== asset.byteSize ||
        createHash("sha256").update(bytes).digest("hex") !== asset.sha256
      )
        throw new Error("Stored image integrity mismatch");
      await access(req, false, async (tx) => {
        if (
          !(await tx.mediaAsset.findFirst({
            where: { ...where(req), status: "ready" },
          }))
        )
          throw new MediaError(404, "Imagem não encontrada.");
      });
      res.setHeader("Content-Type", asset.mimeType!);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.send(bytes);
    }),
  );
  server.patch(
    `${root}/:id`,
    handler(async (req, res) => {
      const parsed = input.safeParse(req.body);
      if (!parsed.success) throw new MediaError(400, "Dados inválidos.");
      const result = await access(req, true, async (tx, userId) => {
        await brand(tx, req, parsed.data.brandId);
        const updated = await tx.mediaAsset.updateMany({
          where: { ...where(req), status: "ready" },
          data: parsed.data,
        });
        if (!updated.count) throw new MediaError(404, "Imagem não encontrada.");
        await audit(tx, req, userId, param(req, "id"), "media.updated");
        return tx.mediaAsset.findFirstOrThrow({
          where: where(req),
          select: publicFields,
        });
      });
      res.json(result);
    }),
  );
  server.delete(
    `${root}/:id`,
    handler(async (req, res) => {
      await access(req, true, async (tx, userId, admin) => {
        if (!admin)
          throw new MediaError(
            403,
            "Somente administradores podem arquivar imagens.",
          );
        const result = await tx.mediaAsset.updateMany({
          where: { ...where(req), status: "ready" },
          data: { archived: true },
        });
        if (!result.count) throw new MediaError(404, "Imagem não encontrada.");
        await audit(tx, req, userId, param(req, "id"), "media.archived");
      });
      res.json({ archived: true });
    }),
  );
  return () => storage?.close?.();
}
