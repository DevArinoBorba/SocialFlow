import type { Express, Request, Response } from "express";
import type {
  Prisma,
  DesignTemplateStatus,
  DesignFormat,
} from "@socialflow/db";
import {
  type Role,
  type SystemTemplateKey,
  designTemplateInputSchema,
  designTemplatePatchSchema,
  designTemplateVersionInputSchema,
  designTemplateDuplicateInputSchema,
  designTemplateListQuerySchema,
  designTemplateSpecSchema,
  type DesignTemplateSpec,
} from "@socialflow/contracts";
import { hashTemplateSpec, RENDERER_VERSION } from "@socialflow/render";
import { sanitizeErrorMessage } from "./log-sanitizer.js";
import { HttpError } from "./errors.js";
import type { Scope } from "./render.js";

export class DesignTemplateError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "DesignTemplateError";
  }
}

export interface DesignTemplateVersionSummaryDto {
  id: string;
  version: number;
  format: DesignFormat;
  specHash: string;
  rendererVersion: string;
  createdAt: string;
}

export interface DesignTemplateListItemDto {
  id: string;
  name: string;
  systemKey: string | null;
  status: DesignTemplateStatus;
  createdAt: string;
  updatedAt: string;
  latestVersion: DesignTemplateVersionSummaryDto | null;
}

export interface DesignTemplateVersionDetailDto {
  id: string;
  version: number;
  format: DesignFormat;
  spec: DesignTemplateSpec;
  specHash: string;
  rendererVersion: string;
  createdAt: string;
}

export interface DesignTemplateDetailDto {
  id: string;
  name: string;
  systemKey: string | null;
  status: DesignTemplateStatus;
  createdAt: string;
  updatedAt: string;
  versions: DesignTemplateVersionDetailDto[];
}

export function toDesignTemplateListItemDto(template: {
  id: string;
  name: string;
  systemKey?: string | null;
  status: DesignTemplateStatus;
  createdAt: Date | string;
  updatedAt: Date | string;
  versions?: Array<{
    id: string;
    version: number;
    format: DesignFormat;
    specHash: string;
    rendererVersion: string;
    createdAt: Date | string;
  }>;
}): DesignTemplateListItemDto {
  const latest = template.versions?.[0];
  return {
    id: template.id,
    name: template.name,
    systemKey: template.systemKey ?? null,
    status: template.status,
    createdAt:
      template.createdAt instanceof Date
        ? template.createdAt.toISOString()
        : String(template.createdAt),
    updatedAt:
      template.updatedAt instanceof Date
        ? template.updatedAt.toISOString()
        : String(template.updatedAt),
    latestVersion: latest
      ? {
          id: latest.id,
          version: latest.version,
          format: latest.format,
          specHash: latest.specHash,
          rendererVersion: latest.rendererVersion,
          createdAt:
            latest.createdAt instanceof Date
              ? latest.createdAt.toISOString()
              : String(latest.createdAt),
        }
      : null,
  };
}

export function toDesignTemplateDetailDto(template: {
  id: string;
  name: string;
  systemKey?: string | null;
  status: DesignTemplateStatus;
  createdAt: Date | string;
  updatedAt: Date | string;
  versions: Array<{
    id: string;
    version: number;
    format: DesignFormat;
    spec: unknown;
    specHash: string;
    rendererVersion: string;
    createdAt: Date | string;
  }>;
}): DesignTemplateDetailDto {
  return {
    id: template.id,
    name: template.name,
    systemKey: template.systemKey ?? null,
    status: template.status,
    createdAt:
      template.createdAt instanceof Date
        ? template.createdAt.toISOString()
        : String(template.createdAt),
    updatedAt:
      template.updatedAt instanceof Date
        ? template.updatedAt.toISOString()
        : String(template.updatedAt),
    versions: template.versions.map((v) => ({
      id: v.id,
      version: v.version,
      format: v.format,
      spec: v.spec as DesignTemplateSpec,
      specHash: v.specHash,
      rendererVersion: v.rendererVersion,
      createdAt:
        v.createdAt instanceof Date
          ? v.createdAt.toISOString()
          : String(v.createdAt),
    })),
  };
}

const disallowedContentPattern =
  /<[a-zA-Z/][^>]*>|(?:https?|ftp|file|javascript|data):|(?:url\(|@import|expression\()/i;

function validateTemplateName(name: string) {
  if (disallowedContentPattern.test(name)) {
    throw new DesignTemplateError(
      400,
      "Nome do template contém conteúdo não permitido (HTML, CSS, URLs ou scripts).",
    );
  }
}

export const DEFAULT_DESIGN_TEMPLATES: Array<{
  systemKey: SystemTemplateKey;
  defaultName: string;
  spec: DesignTemplateSpec;
}> = [
  {
    systemKey: "EDITORIAL_SQUARE",
    defaultName: "Editorial Square",
    spec: {
      schemaVersion: 1,
      format: "SQUARE",
      backgroundColor: "#0F172A",
      overlayColor: "#020617",
      overlayOpacity: 0.3,
      textColor: "#F8FAFC",
      mutedTextColor: "#94A3B8",
      accentColor: "#38BDF8",
      safeArea: 80,
      textAlign: "left",
      titleMaxLines: 3,
      showEyebrow: true,
      showSubtitle: true,
      showCallToAction: true,
    },
  },
  {
    systemKey: "EDITORIAL_PORTRAIT",
    defaultName: "Editorial Portrait",
    spec: {
      schemaVersion: 1,
      format: "PORTRAIT",
      backgroundColor: "#0F172A",
      overlayColor: "#020617",
      overlayOpacity: 0.3,
      textColor: "#F8FAFC",
      mutedTextColor: "#94A3B8",
      accentColor: "#38BDF8",
      safeArea: 80,
      textAlign: "left",
      titleMaxLines: 3,
      showEyebrow: true,
      showSubtitle: true,
      showCallToAction: true,
    },
  },
  {
    systemKey: "EDITORIAL_STORY",
    defaultName: "Editorial Story",
    spec: {
      schemaVersion: 1,
      format: "STORY",
      backgroundColor: "#0F172A",
      overlayColor: "#020617",
      overlayOpacity: 0.3,
      textColor: "#F8FAFC",
      mutedTextColor: "#94A3B8",
      accentColor: "#38BDF8",
      safeArea: 120,
      textAlign: "left",
      titleMaxLines: 4,
      showEyebrow: true,
      showSubtitle: true,
      showCallToAction: true,
    },
  },
];

export function registerDesignTemplates(server: Express, scoped: Scope) {
  const root = "/api/organizations/:org/clients/:clientId/design-templates";
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
      if (!client)
        throw new DesignTemplateError(404, "Cliente não encontrado.");

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
          throw new DesignTemplateError(404, "Cliente não encontrado.");
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
        throw new DesignTemplateError(
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
        if (error instanceof DesignTemplateError) {
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
            event: "design_template_request_failed",
            errorCode: "INTERNAL_UNEXPECTED_ERROR",
            error: sanitized,
          }),
        );
        res.status(500).json({ message: "Erro interno do servidor." });
      }
    };
  }

  const READ_ROLES: Role[] = [
    "OWNER",
    "ADMIN",
    "EDITOR",
    "APPROVER",
    "CLIENT_VIEWER",
  ];
  const WRITE_ROLES: Role[] = ["OWNER", "ADMIN", "EDITOR"];
  const ADMIN_ROLES: Role[] = ["OWNER", "ADMIN"];

  // 1. Listar templates
  server.get(
    root,
    handler(async (req, res) => {
      const parsedQuery = designTemplateListQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        throw new DesignTemplateError(400, "Parâmetros de consulta inválidos.");
      }

      const { limit, cursor, status, search } = parsedQuery.data;
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");

      const result = await access(req, READ_ROLES, async (tx) => {
        const where: Prisma.DesignTemplateWhereInput = {
          organizationId,
          clientId,
          ...(status ? { status } : {}),
          ...(search
            ? {
                name: {
                  contains: search,
                  mode: "insensitive",
                },
              }
            : {}),
        };

        const rows = await tx.designTemplate.findMany({
          where,
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          include: {
            versions: {
              orderBy: { version: "desc" },
              take: 1,
            },
          },
        });

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor =
          hasMore && items.length > 0 ? items[items.length - 1]!.id : null;

        return {
          items: items.map(toDesignTemplateListItemDto),
          nextCursor,
          hasMore,
        };
      });

      res.status(200).json(result);
    }),
  );

  // 2. Criar template inicial padrão (idempotente)
  server.post(
    `${root}/default`,
    handler(async (req, res) => {
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");

      const result = await access(req, ADMIN_ROLES, async (tx, userId) => {
        // Serializa a criação de templates padrão no nível de transação para evitar duplicatas concorrentes
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${`default_templates:${clientId}`}))
        `;

        const existingTemplates = await tx.designTemplate.findMany({
          where: {
            organizationId,
            clientId,
            systemKey: {
              in: DEFAULT_DESIGN_TEMPLATES.map((t) => t.systemKey),
            },
          },
          include: {
            versions: {
              orderBy: { version: "desc" },
              take: 1,
            },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });

        const existingKeys = new Set(
          existingTemplates
            .map((t) => t.systemKey)
            .filter((k): k is SystemTemplateKey => Boolean(k)),
        );
        const missingDefaults = DEFAULT_DESIGN_TEMPLATES.filter(
          (t) => !existingKeys.has(t.systemKey),
        );

        const createdTemplates: Array<
          Parameters<typeof toDesignTemplateListItemDto>[0]
        > = [];

        for (const item of missingDefaults) {
          validateTemplateName(item.defaultName);
          const spec = designTemplateSpecSchema.parse(item.spec);
          const specHash = hashTemplateSpec(spec);

          const template = await tx.designTemplate.create({
            data: {
              organizationId,
              clientId,
              name: item.defaultName,
              systemKey: item.systemKey,
              status: "ACTIVE",
            },
          });

          const version = await tx.designTemplateVersion.create({
            data: {
              organizationId,
              clientId,
              templateId: template.id,
              version: 1,
              format: spec.format,
              spec: spec as unknown as Prisma.InputJsonValue,
              specHash,
              rendererVersion: RENDERER_VERSION,
            },
          });

          await tx.auditLog.create({
            data: {
              organizationId,
              actorUserId: userId,
              entityId: template.id,
              action: "design_template.created",
            },
          });

          await tx.auditLog.create({
            data: {
              organizationId,
              actorUserId: userId,
              entityId: version.id,
              action: "design_template.version_created",
            },
          });

          createdTemplates.push({
            ...template,
            versions: [version],
          });
        }

        const allTemplates = [...existingTemplates, ...createdTemplates];
        const orderedTemplates = DEFAULT_DESIGN_TEMPLATES.map((def) =>
          allTemplates.find((t) => t.systemKey === def.systemKey)!,
        );

        return {
          created: missingDefaults.length > 0,
          templates: orderedTemplates.map(toDesignTemplateListItemDto),
        };
      });

      res.status(result.created ? 201 : 200).json(result.templates);
    }),
  );

  // 3. Consultar template individual com todas as versões
  server.get(
    `${root}/:templateId`,
    handler(async (req, res) => {
      const templateId = param(req, "templateId");
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");

      const template = await access(req, READ_ROLES, async (tx) => {
        const found = await tx.designTemplate.findFirst({
          where: {
            id: templateId,
            organizationId,
            clientId,
          },
          include: {
            versions: {
              orderBy: { version: "desc" },
            },
          },
        });

        if (!found) {
          throw new DesignTemplateError(
            404,
            "Template de design não encontrado.",
          );
        }

        return found;
      });

      res.status(200).json(toDesignTemplateDetailDto(template));
    }),
  );

  // 4. Criar novo template (com versão 1)
  server.post(
    root,
    handler(async (req, res) => {
      const parsedBody = designTemplateInputSchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw new DesignTemplateError(
          400,
          "Dados inválidos para criação do template.",
        );
      }

      const { name, spec } = parsedBody.data;
      validateTemplateName(name);

      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");

      const created = await access(req, WRITE_ROLES, async (tx, userId) => {
        const specHash = hashTemplateSpec(spec);

        const template = await tx.designTemplate.create({
          data: {
            organizationId,
            clientId,
            name,
            systemKey: null,
            status: "ACTIVE",
          },
        });

        const version = await tx.designTemplateVersion.create({
          data: {
            organizationId,
            clientId,
            templateId: template.id,
            version: 1,
            format: spec.format,
            spec: spec as unknown as Prisma.InputJsonValue,
            specHash,
            rendererVersion: RENDERER_VERSION,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: userId,
            entityId: template.id,
            action: "design_template.created",
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: userId,
            entityId: version.id,
            action: "design_template.version_created",
          },
        });

        return {
          ...template,
          versions: [version],
        };
      });

      res.status(201).json(toDesignTemplateDetailDto(created));
    }),
  );

  // 5. Renomear ou arquivar template
  server.patch(
    `${root}/:templateId`,
    handler(async (req, res) => {
      const parsedBody = designTemplatePatchSchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw new DesignTemplateError(
          400,
          "Parâmetros inválidos para atualização do template.",
        );
      }

      const { name, status } = parsedBody.data;
      if (name !== undefined) {
        validateTemplateName(name);
      }

      const templateId = param(req, "templateId");
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");

      const updated = await access(
        req,
        WRITE_ROLES,
        async (tx, userId, role) => {
          const current = await tx.designTemplate.findFirst({
            where: {
              id: templateId,
              organizationId,
              clientId,
            },
            include: {
              versions: {
                orderBy: { version: "desc" },
              },
            },
          });

          if (!current) {
            throw new DesignTemplateError(
              404,
              "Template de design não encontrado.",
            );
          }

          const nameChanged = name !== undefined && name !== current.name;
          const statusChanged =
            status !== undefined && status !== current.status;

          // Se status mudando para ACTIVE (reativação)
          if (
            statusChanged &&
            status === "ACTIVE" &&
            current.status === "ARCHIVED"
          ) {
            if (role !== "OWNER" && role !== "ADMIN") {
              throw new DesignTemplateError(
                403,
                "Apenas proprietários ou administradores podem reativar templates.",
              );
            }
          }

          // Se nada mudou, retornar sem gravar auditoria nem alterarUpdatedAt
          if (!nameChanged && !statusChanged) {
            return current;
          }

          const template = await tx.designTemplate.update({
            where: { id: current.id },
            data: {
              ...(nameChanged ? { name } : {}),
              ...(statusChanged ? { status } : {}),
            },
            include: {
              versions: {
                orderBy: { version: "desc" },
              },
            },
          });

          if (nameChanged) {
            await tx.auditLog.create({
              data: {
                organizationId,
                actorUserId: userId,
                entityId: template.id,
                action: "design_template.renamed",
              },
            });
          }

          if (statusChanged) {
            await tx.auditLog.create({
              data: {
                organizationId,
                actorUserId: userId,
                entityId: template.id,
                action:
                  status === "ARCHIVED"
                    ? "design_template.archived"
                    : "design_template.reactivated",
              },
            });
          }

          return template;
        },
      );

      res.status(200).json(toDesignTemplateDetailDto(updated));
    }),
  );

  // 6. Criar nova versão
  server.post(
    `${root}/:templateId/versions`,
    handler(async (req, res) => {
      const parsedBody = designTemplateVersionInputSchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw new DesignTemplateError(
          400,
          "Especificação inválida para nova versão.",
        );
      }

      const { spec } = parsedBody.data;
      const templateId = param(req, "templateId");
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");

      const createdVersion = await access(
        req,
        WRITE_ROLES,
        async (tx, userId) => {
          // Bloquear linha do template pai para serializar a contagem de versões
          const lockedTemplates = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "DesignTemplate"
            WHERE id = ${templateId} AND "organizationId" = ${organizationId} AND "clientId" = ${clientId}
            FOR UPDATE
          `;

          if (!lockedTemplates || lockedTemplates.length === 0) {
            throw new DesignTemplateError(
              404,
              "Template de design não encontrado.",
            );
          }

          const template = await tx.designTemplate.findFirst({
            where: {
              id: templateId,
              organizationId,
              clientId,
            },
          });

          if (!template) {
            throw new DesignTemplateError(
              404,
              "Template de design não encontrado.",
            );
          }

          if (template.status !== "ACTIVE") {
            throw new DesignTemplateError(
              400,
              "Template arquivado não aceita novas versões.",
            );
          }

          const latestVersionRecord = await tx.designTemplateVersion.findFirst({
            where: {
              templateId: template.id,
              organizationId,
              clientId,
            },
            orderBy: { version: "desc" },
            select: { version: true },
          });

          const nextVersion = (latestVersionRecord?.version ?? 0) + 1;
          const specHash = hashTemplateSpec(spec);

          try {
            const version = await tx.designTemplateVersion.create({
              data: {
                organizationId,
                clientId,
                templateId: template.id,
                version: nextVersion,
                format: spec.format,
                spec: spec as unknown as Prisma.InputJsonValue,
                specHash,
                rendererVersion: RENDERER_VERSION,
              },
            });

            await tx.auditLog.create({
              data: {
                organizationId,
                actorUserId: userId,
                entityId: version.id,
                action: "design_template.version_created",
              },
            });

            return {
              id: version.id,
              version: version.version,
              format: version.format,
              spec: version.spec as DesignTemplateSpec,
              specHash: version.specHash,
              rendererVersion: version.rendererVersion,
              createdAt: version.createdAt.toISOString(),
            };
          } catch (error: unknown) {
            if (
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "P2002"
            ) {
              throw new DesignTemplateError(
                409,
                "Conflito de concorrência ao criar versão. Tente novamente.",
              );
            }
            throw error;
          }
        },
      );

      res.status(201).json(createdVersion);
    }),
  );

  // 7. Duplicar template
  server.post(
    `${root}/:templateId/duplicate`,
    handler(async (req, res) => {
      const parsedBody = designTemplateDuplicateInputSchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw new DesignTemplateError(
          400,
          "Nome inválido para duplicação do template.",
        );
      }

      const { name } = parsedBody.data;
      validateTemplateName(name);

      const templateId = param(req, "templateId");
      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");

      const duplicated = await access(req, WRITE_ROLES, async (tx, userId) => {
        const source = await tx.designTemplate.findFirst({
          where: {
            id: templateId,
            organizationId,
            clientId,
          },
          include: {
            versions: {
              orderBy: { version: "desc" },
              take: 1,
            },
          },
        });

        if (!source) {
          throw new DesignTemplateError(
            404,
            "Template de origem não encontrado.",
          );
        }

        const latestVersion = source.versions[0];
        if (!latestVersion) {
          throw new DesignTemplateError(
            404,
            "Versão do template de origem não encontrada.",
          );
        }

        const spec = designTemplateSpecSchema.parse(latestVersion.spec);
        const specHash = hashTemplateSpec(spec);

        const newTemplate = await tx.designTemplate.create({
          data: {
            organizationId,
            clientId,
            name,
            systemKey: null,
            status: "ACTIVE",
          },
        });

        const newVersion = await tx.designTemplateVersion.create({
          data: {
            organizationId,
            clientId,
            templateId: newTemplate.id,
            version: 1,
            format: spec.format,
            spec: spec as unknown as Prisma.InputJsonValue,
            specHash,
            rendererVersion: RENDERER_VERSION,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: userId,
            entityId: newTemplate.id,
            action: "design_template.duplicated",
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: userId,
            entityId: newVersion.id,
            action: "design_template.version_created",
          },
        });

        return {
          ...newTemplate,
          versions: [newVersion],
        };
      });

      res.status(201).json(toDesignTemplateDetailDto(duplicated));
    }),
  );
}
