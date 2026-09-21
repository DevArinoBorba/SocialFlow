import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Req,
  Res,
  Param,
  Module,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import {
  asActor,
  createDatabase,
  assertRuntimeRole,
  type Prisma,
} from "@socialflow/db";
import { bounded, type Config } from "@socialflow/config";
import {
  brandInput,
  brandUpdate,
  clientInput,
  clientUpdate,
  isAdmin,
} from "@socialflow/contracts";
import { createAuth } from "./auth.js";
import { registerMedia, type MediaDependencies } from "./media.js";
import { registerContent } from "./content.js";
import {
  registerSocialAccounts,
  type SocialAccountDependencies,
} from "./social-accounts.js";
import {
  registerPublication,
  type PublicationDependencies,
} from "./publication.js";
import { registerScheduler } from "./scheduler.js";
import { createScheduleQueue, closeScheduleQueue } from "./scheduler-queue.js";
import { registerRender } from "./render.js";
import { registerDesignTemplates } from "./design-templates.js";
import {
  createRenderQueue,
  closeRenderQueue,
  type RenderJobData,
} from "./render-queue.js";

import { HttpError } from "./errors.js";
export { HttpError };

export interface CreateApplicationOptions {
  mediaDependencies?: MediaDependencies;
  socialAccountDependencies?: SocialAccountDependencies;
  publicationDependencies?: PublicationDependencies;
  renderQueue?: Queue<RenderJobData>;
}

export async function createApplication(
  config: Config,
  options?: CreateApplicationOptions,
) {
  const db = createDatabase(config.DATABASE_URL);
  await assertRuntimeRole(db);
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2500,
    commandTimeout: 2500,
  });
  redis.on("error", () =>
    console.error(JSON.stringify({ event: "redis_unavailable" })),
  );
  const queue = new Queue("diagnostics", { connection: redis });
  const schedulerQueue = createScheduleQueue(redis);
  const renderQueue = options?.renderQueue ?? createRenderQueue(redis);
  const auth = createAuth(db, config);
  const server = express();
  server.disable("x-powered-by");
  server.use((req, res, next) => {
    req.headers["x-forwarded-for"] = req.socket.remoteAddress ?? "127.0.0.1";
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.on("finish", () =>
      console.info(
        JSON.stringify({
          event: "http",
          requestId,
          method: req.method,
          status: res.statusCode,
        }),
      ),
    );
    // No trust-proxy: caller-supplied forwarded IP cannot evade auth rate limiting.
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.APP_URL
    ) {
      res.status(403).json({ message: "Origem não autorizada." });
      return;
    }
    next();
  });
  const allowedAuth = new Set(["/sign-in/email", "/get-session", "/sign-out"]);
  server.use("/api/auth", (req, res, next) => {
    if (!allowedAuth.has(req.path)) {
      res.status(404).json({ message: "Rota indisponível." });
      return;
    }
    next();
  });
  server.all("/api/auth/*path", toNodeHandler(auth));
  server.use(express.json({ limit: "16kb" }));

  async function actor(req: Request) {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) throw new HttpError(401, "Sessão expirada. Entre novamente.");
    const user = await db.user.findFirst({
      where: { id: session.user.id, active: true },
      select: { id: true, name: true, email: true },
    });
    if (!user) throw new HttpError(401, "Sessão expirada. Entre novamente.");
    return user;
  }
  async function scoped<T>(
    req: Request,
    organizationId: string,
    fn: (
      tx: Prisma.TransactionClient,
      userId: string,
      admin: boolean,
    ) => Promise<T>,
  ) {
    const user = await actor(req);
    return asActor(db, user.id, async (tx) => {
      const memberships = await tx.membership.findMany({
        where: {
          userId: user.id,
          organizationId,
          active: true,
          organization: { active: true },
        },
      });
      if (!memberships.length)
        throw new HttpError(404, "Organização não encontrada.");
      return fn(
        tx,
        user.id,
        memberships.some((m) => isAdmin(m.role) && m.clientId === null),
      );
    });
  }
  async function respond(
    res: Response,
    fn: () => Promise<unknown>,
    success = 200,
  ) {
    try {
      res.status(success).json(await fn());
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).json({ message: error.message });
        return;
      }
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2002"
      ) {
        res
          .status(409)
          .json({ message: "Este identificador já existe nesta organização." });
        return;
      }
      console.error(JSON.stringify({ event: "request_failed" }));
      res
        .status(503)
        .json({ message: "Serviço indisponível. Tente novamente." });
    }
  }
  const closeMedia = registerMedia(server, scoped, {
    ...options?.mediaDependencies,
    sessionSecret: config.SESSION_SECRET,
    redis,
  });
  registerContent(server, scoped);
  registerSocialAccounts(
    server,
    scoped,
    redis,
    config,
    options?.socialAccountDependencies,
  );
  registerPublication(
    server,
    scoped,
    redis,
    config,
    options?.publicationDependencies,
  );
  registerScheduler(server, scoped, schedulerQueue);
  registerRender(server, scoped, renderQueue);
  registerDesignTemplates(server, scoped);
  @Controller()
  class FoundationController {
    @Get("health/live") live() {
      return { status: "ok" };
    }
    @Get("health/ready") ready(@Res() res: Response) {
      return respond(res, async () => {
        await bounded(Promise.all([db.$queryRaw`SELECT 1`, redis.ping()]));
        return { status: "ready" };
      });
    }
    @Get("api/me") me(@Req() req: Request, @Res() res: Response) {
      return respond(res, async () => {
        const user = await actor(req);
        const memberships = await asActor(db, user.id, (tx) =>
          tx.membership.findMany({
            where: {
              userId: user.id,
              active: true,
              organization: { active: true },
            },
            select: {
              organizationId: true,
              clientId: true,
              role: true,
              organization: { select: { name: true } },
            },
          }),
        );
        return { user, memberships };
      });
    }
    @Get("api/organizations/:org/clients") list(
      @Req() req: Request,
      @Res() res: Response,
      @Param("org") org: string,
    ) {
      return respond(res, () =>
        scoped(req, org, (tx) =>
          tx.client.findMany({
            where: { organizationId: org, active: true },
            orderBy: { name: "asc" },
            take: 100,
          }),
        ),
      );
    }
    @Get("api/organizations/:org/clients/:id") detail(
      @Req() req: Request,
      @Res() res: Response,
      @Param("org") org: string,
      @Param("id") id: string,
    ) {
      return respond(res, () =>
        scoped(req, org, async (tx) => {
          const client = await tx.client.findFirst({
            where: { id, organizationId: org, active: true },
          });
          if (!client) throw new HttpError(404, "Cliente não encontrado.");
          return client;
        }),
      );
    }
    @Post("api/organizations/:org/clients") create(
      @Req() req: Request,
      @Res() res: Response,
      @Param("org") org: string,
    ) {
      return respond(
        res,
        () =>
          scoped(req, org, async (tx, userId, admin) => {
            if (!admin)
              throw new HttpError(403, "Seu perfil não pode criar clientes.");
            const parsed = clientInput.safeParse(req.body);
            if (!parsed.success)
              throw new HttpError(
                400,
                "Informe nome e identificador válidos, sem campos adicionais.",
              );
            const client = await tx.client.create({
              data: { ...parsed.data, organizationId: org },
            });
            await tx.auditLog.create({
              data: {
                organizationId: org,
                actorUserId: userId,
                entityId: client.id,
                action: "client.created",
              },
            });
            return client;
          }),
        201,
      );
    }
    @Patch("api/organizations/:org/clients/:id") update(
      @Req() req: Request,
      @Res() res: Response,
      @Param("org") org: string,
      @Param("id") id: string,
    ) {
      return respond(res, () =>
        scoped(req, org, async (tx, userId, admin) => {
          const client = await tx.client.findFirst({
            where: { id, organizationId: org, active: true },
          });
          if (!client) throw new HttpError(404, "Cliente não encontrado.");
          const editor = await tx.membership.findFirst({
            where: {
              userId,
              organizationId: org,
              clientId: id,
              role: "EDITOR",
              active: true,
            },
          });
          if (!admin && !editor)
            throw new HttpError(403, "Seu perfil não pode editar clientes.");
          const parsed = clientUpdate.safeParse(req.body);
          if (!parsed.success)
            throw new HttpError(
              400,
              "Informe um nome válido, sem campos adicionais.",
            );
          const updated = await tx.client.update({
            where: { organizationId_id: { organizationId: org, id } },
            data: parsed.data,
          });
          await tx.auditLog.create({
            data: {
              organizationId: org,
              actorUserId: userId,
              entityId: id,
              action: "client.updated",
            },
          });
          return updated;
        }),
      );
    }
    @Delete("api/organizations/:org/clients/:id") remove(
      @Req() req: Request,
      @Res() res: Response,
      @Param("org") org: string,
      @Param("id") id: string,
    ) {
      return respond(res, () =>
        scoped(req, org, async (tx, userId, admin) => {
          if (!admin)
            throw new HttpError(403, "Seu perfil não pode arquivar clientes.");
          const count = await tx.client.updateMany({
            where: { id, organizationId: org, active: true },
            data: { active: false },
          });
          if (!count.count) throw new HttpError(404, "Cliente não encontrado.");
          await tx.auditLog.create({
            data: {
              organizationId: org,
              actorUserId: userId,
              entityId: id,
              action: "client.archived",
            },
          });
          return { archived: true };
        }),
      );
    }
    @Post("api/organizations/:org/diagnostics") diagnostic(
      @Req() req: Request,
      @Res() res: Response,
      @Param("org") org: string,
    ) {
      return respond(
        res,
        async () => {
          const userId = await scoped(req, org, async (_tx, id, admin) => {
            if (!admin) throw new HttpError(403, "Acesso negado.");
            return id;
          });
          const job = await queue.add(
            "diagnostic",
            { organizationId: org, userId },
            {
              jobId: randomUUID(),
              attempts: 2,
              backoff: { type: "exponential", delay: 1000 },
              removeOnComplete: 100,
              removeOnFail: 100,
            },
          );
          return { jobId: job.id };
        },
        202,
      );
    }
    @Get("api/organizations/:org/clients/:clientId/brands") listBrands(
      @Req() req: Request,
      @Res() res: Response,
      @Param("org") org: string,
      @Param("clientId") clientId: string,
    ) {
      return respond(res, () =>
        scoped(req, org, async (tx, userId, admin) => {
          const client = await tx.client.findFirst({
            where: { id: clientId, organizationId: org, active: true },
          });
          if (!client) throw new HttpError(404, "Cliente não encontrado.");
          if (!admin) {
            const member = await tx.membership.findFirst({
              where: {
                userId,
                organizationId: org,
                clientId,
                active: true,
              },
            });
            if (!member) throw new HttpError(404, "Cliente não encontrado.");
          }
          return tx.brand.findMany({
            where: { organizationId: org, clientId },
            orderBy: { name: "asc" },
            take: 100,
          });
        }),
      );
    }
    @Get("api/organizations/:org/clients/:clientId/brands/:brandId")
    detailBrand(
      @Req() req: Request,
      @Res() res: Response,
      @Param("org") org: string,
      @Param("clientId") clientId: string,
      @Param("brandId") brandId: string,
    ) {
      return respond(res, () =>
        scoped(req, org, async (tx, userId, admin) => {
          const client = await tx.client.findFirst({
            where: { id: clientId, organizationId: org, active: true },
          });
          if (!client) throw new HttpError(404, "Cliente não encontrado.");
          if (!admin) {
            const member = await tx.membership.findFirst({
              where: {
                userId,
                organizationId: org,
                clientId,
                active: true,
              },
            });
            if (!member) throw new HttpError(404, "Cliente não encontrado.");
          }
          const brand = await tx.brand.findFirst({
            where: { id: brandId, organizationId: org, clientId },
          });
          if (!brand) throw new HttpError(404, "Marca não encontrada.");
          return brand;
        }),
      );
    }
    @Post("api/organizations/:org/clients/:clientId/brands") createBrand(
      @Req() req: Request,
      @Res() res: Response,
      @Param("org") org: string,
      @Param("clientId") clientId: string,
    ) {
      return respond(
        res,
        () =>
          scoped(req, org, async (tx, userId, admin) => {
            const client = await tx.client.findFirst({
              where: { id: clientId, organizationId: org, active: true },
            });
            if (!client) throw new HttpError(404, "Cliente não encontrado.");
            let canWrite = admin;
            if (!canWrite) {
              const member = await tx.membership.findFirst({
                where: {
                  userId,
                  organizationId: org,
                  clientId,
                  active: true,
                },
              });
              if (!member) throw new HttpError(404, "Cliente não encontrado.");
              if (member.role === "EDITOR") canWrite = true;
            }
            if (!canWrite) {
              throw new HttpError(403, "Seu perfil não pode criar marcas.");
            }
            const parsed = brandInput.safeParse(req.body);
            if (!parsed.success) {
              throw new HttpError(
                400,
                "Informe dados válidos para a marca, sem campos adicionais.",
              );
            }
            const brand = await tx.brand.create({
              data: {
                name: parsed.data.name,
                description: parsed.data.description,
                targetAudience: parsed.data.targetAudience,
                toneOfVoice: parsed.data.toneOfVoice,
                organizationId: org,
                clientId,
              },
            });
            await tx.auditLog.create({
              data: {
                organizationId: org,
                actorUserId: userId,
                entityId: brand.id,
                action: "brand.created",
              },
            });
            return brand;
          }),
        201,
      );
    }
    @Patch("api/organizations/:org/clients/:clientId/brands/:brandId")
    updateBrand(
      @Req() req: Request,
      @Res() res: Response,
      @Param("org") org: string,
      @Param("clientId") clientId: string,
      @Param("brandId") brandId: string,
    ) {
      return respond(res, () =>
        scoped(req, org, async (tx, userId, admin) => {
          const client = await tx.client.findFirst({
            where: { id: clientId, organizationId: org, active: true },
          });
          if (!client) throw new HttpError(404, "Cliente não encontrado.");
          let canWrite = admin;
          if (!canWrite) {
            const member = await tx.membership.findFirst({
              where: {
                userId,
                organizationId: org,
                clientId,
                active: true,
              },
            });
            if (!member) throw new HttpError(404, "Cliente não encontrado.");
            if (member.role === "EDITOR") canWrite = true;
          }
          if (!canWrite) {
            throw new HttpError(403, "Seu perfil não pode editar marcas.");
          }
          const brand = await tx.brand.findFirst({
            where: { id: brandId, organizationId: org, clientId },
          });
          if (!brand) throw new HttpError(404, "Marca não encontrada.");
          const parsed = brandUpdate.safeParse(req.body);
          if (!parsed.success) {
            throw new HttpError(
              400,
              "Informe dados válidos para a marca, sem campos adicionais.",
            );
          }
          const updated = await tx.brand.update({
            where: { organizationId_id: { organizationId: org, id: brandId } },
            data: {
              name: parsed.data.name,
              description: parsed.data.description,
              targetAudience: parsed.data.targetAudience,
              toneOfVoice: parsed.data.toneOfVoice,
            },
          });
          await tx.auditLog.create({
            data: {
              organizationId: org,
              actorUserId: userId,
              entityId: brandId,
              action: "brand.updated",
            },
          });
          return updated;
        }),
      );
    }
  }
  @Module({ controllers: [FoundationController] })
  class FoundationModule {}
  const app = await NestFactory.create(
    FoundationModule,
    new ExpressAdapter(server),
    { bodyParser: false, logger: ["error", "warn"] },
  );
  server.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      void error;
      void _next;
      res.status(400).json({ message: "Requisição inválida." });
    },
  );
  await app.init();
  return {
    app,
    db,
    redis,
    queue,
    schedulerQueue,
    renderQueue,
    auth,
    close: async () => {
      closeMedia();
      await app.close();
      await queue.close();
      await closeScheduleQueue(schedulerQueue);
      await closeRenderQueue(renderQueue);
      redis.disconnect();
      await db.$disconnect();
    },
  };
}
