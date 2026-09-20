import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  createDatabase,
  createCredentialCrypto,
} from "../../packages/db/src/index.js";
import { readConfig } from "../../packages/config/src/index.js";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
// @ts-expect-error dist output does not emit d.ts
import { createApplication } from "../../apps/api/dist/app.js";
import {
  startMetaMockServer,
  type MetaMockServer,
} from "../helpers/meta-mock.js";
import { MetaPublisherAdapter } from "../../apps/api/dist/meta-publisher.js";
import {
  processScheduleJob,
  runStartupReconciliation,
} from "../../apps/worker/dist/scheduler-worker.js";

const db = createDatabase(process.env.DATABASE_URL!);
const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);
const migrationClient = migration as unknown as Parameters<
  typeof processScheduleJob
>[1];

const TEST_KEY_32 = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const cryptoHelper = createCredentialCrypto(TEST_KEY_32);

describe("Fase 4: Agendamento Seguro de Publicações com BullMQ", () => {
  let metaMock: MetaMockServer;
  let redis: Redis;
  let appRuntime: Awaited<ReturnType<typeof createApplication>>;
  let apiBase: string;
  let mockPublisher: MetaPublisherAdapter;
  let appConfig: ReturnType<typeof readConfig>;
  const origin = process.env.APP_URL!;
  const password = process.env.DEV_SEED_PASSWORD!;

  async function request(
    path: string,
    cookie = "",
    method = "GET",
    payload?: unknown,
  ) {
    const headers: Record<string, string> = {
      origin,
    };
    if (cookie) headers["cookie"] = cookie;
    let body: string | undefined;
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(payload);
    }
    return fetch(`${apiBase}${path}`, {
      method,
      headers,
      body,
    });
  }

  async function login(id: string) {
    const res = await request("/api/auth/sign-in/email", "", "POST", {
      email: `${id}@socialflow.test`,
      password,
    });
    expect(res.status).toBe(200);
    return res.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join("; ");
  }

  const mockStorageMap = new Map<string, Buffer>();
  const mockStorage = {
    put: async (key: string, data: Buffer) => {
      mockStorageMap.set(key, data);
    },
    get: async (key: string) => {
      const found = mockStorageMap.get(key);
      if (!found) throw new Error("Object not found in mock storage");
      return found;
    },
    delete: async (key: string) => {
      mockStorageMap.delete(key);
    },
    close: async () => {},
  };

  beforeAll(async () => {
    await db.$connect();
    await migration.$connect();

    metaMock = await startMetaMockServer();
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });

    appConfig = readConfig({
      ...process.env,
      META_APP_ID: "meta-test-app-id",
      META_APP_SECRET: "meta-test-app-secret",
      META_GRAPH_URL: metaMock.url,
      CREDENTIAL_MASTER_KEY: TEST_KEY_32.toString("hex"),
    });

    mockPublisher = new MetaPublisherAdapter({
      graphBaseUrl: metaMock.url,
      pollDelayMs: 10,
      pollMaxAttempts: 5,
    });

    appRuntime = await createApplication(appConfig, {
      publicationDependencies: {
        publisher: mockPublisher,
        masterKey: TEST_KEY_32,
      },
      mediaDependencies: {
        storage: mockStorage,
      },
    });

    await appRuntime.app.listen(0, "127.0.0.1");
    const serverAddr = appRuntime.app.getHttpServer().address() as AddressInfo;
    apiBase = `http://127.0.0.1:${serverAddr.port}`;
  });

  afterAll(async () => {
    await migration.auditLog.deleteMany({});
    await migration.publicationAttempt.deleteMany({});
    await migration.publicationSchedule.deleteMany({});
    await migration.oAuthCredential.deleteMany({});
    await migration.socialAccount.deleteMany({});
    await migration.post.deleteMany({});
    await migration.mediaAsset.deleteMany({});

    redis.disconnect();
    await appRuntime.close();
    await metaMock.close();
    await db.$disconnect();
    await migration.$disconnect();
  });

  beforeEach(async () => {
    await migration.rateLimit.deleteMany({});
    mockStorageMap.clear();
  });

  // Helper para criar contas e post
  async function setupAccountsAndPost() {
    const facebookAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: "page_sched_" + randomUUID().substring(0, 8),
        name: "Página Agendamento Teste",
        status: "ACTIVE",
      },
    });

    const fbContext = {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: facebookAccount.platformAccountId,
      keyVersion: 1,
    };
    const encryptedTokenFb = cryptoHelper.encrypt(
      "valid_meta_page_token",
      fbContext,
    );
    await migration.oAuthCredential.create({
      data: {
        socialAccountId: facebookAccount.id,
        encryptedAccessToken: encryptedTokenFb.encryptedAccessToken,
        iv: encryptedTokenFb.iv,
        authTag: encryptedTokenFb.authTag,
        keyVersion: 1,
        tokenType: "PAGE_ACCESS_TOKEN",
        scopes: ["pages_manage_posts", "pages_read_engagement"],
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const instagramAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "INSTAGRAM_BUSINESS",
        platformAccountId: "ig_sched_" + randomUUID().substring(0, 8),
        name: "Instagram Agendamento Teste",
        status: "ACTIVE",
      },
    });

    const igContext = {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: instagramAccount.platformAccountId,
      keyVersion: 1,
    };
    const encryptedTokenIg = cryptoHelper.encrypt("valid_token", igContext);
    await migration.oAuthCredential.create({
      data: {
        socialAccountId: instagramAccount.id,
        encryptedAccessToken: encryptedTokenIg.encryptedAccessToken,
        iv: encryptedTokenIg.iv,
        authTag: encryptedTokenIg.authTag,
        keyVersion: 1,
        tokenType: "PAGE_ACCESS_TOKEN",
        scopes: ["instagram_basic", "instagram_content_publish"],
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const approvedPost = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Post Aprovado para Agendamento Teste",
        status: "APPROVED",
      },
    });

    const mediaId = randomUUID();
    const media = await migration.mediaAsset.create({
      data: {
        id: mediaId,
        organizationId: "org-a",
        clientId: "client-a",
        name: "sched.jpg",
        storageKey: `media/org-a/client-a/${mediaId}`,
        status: "ready",
        mimeType: "image/jpeg",
        byteSize: 10240,
        width: 1080,
        height: 1080,
        sha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    });
    mockStorageMap.set(media.storageKey, Buffer.from("image_data_mock"));

    return { facebookAccount, instagramAccount, approvedPost, media };
  }

  // 1. Validações e Rejeições
  describe("1. Validações e Rejeições de Agendamento", () => {
    it("rejeita agendamento com data/hora no passado com 400", async () => {
      const cookie = await login("admin-a");
      const { facebookAccount, approvedPost } = await setupAccountsAndPost();

      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules`,
        cookie,
        "POST",
        {
          scheduledLocalTime: "2020-01-01T10:00",
          scheduledTimezone: "America/Cuiaba",
          targetAccountIds: [facebookAccount.id],
          confirmed: true,
        },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("posterior ao momento atual");
    });

    it("rejeita agendamento com timezone inválido com 400", async () => {
      const cookie = await login("admin-a");
      const { facebookAccount, approvedPost } = await setupAccountsAndPost();

      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules`,
        cookie,
        "POST",
        {
          scheduledLocalTime: "2030-01-01T10:00",
          scheduledTimezone: "Invalid/Timezone",
          targetAccountIds: [facebookAccount.id],
          confirmed: true,
        },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("Fuso horário IANA inválido");
    });

    it("rejeita agendamento para post que não esteja APPROVED com 422", async () => {
      const cookie = await login("admin-a");
      const { facebookAccount } = await setupAccountsAndPost();

      const draftPost = await migration.post.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          caption: "Post em rascunho",
          status: "DRAFT",
        },
      });

      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${draftPost.id}/schedules`,
        cookie,
        "POST",
        {
          scheduledLocalTime: "2030-01-01T10:00",
          scheduledTimezone: "America/Cuiaba",
          targetAccountIds: [facebookAccount.id],
          confirmed: true,
        },
      );

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.message).toContain("publicações aprovadas");
    });

    it("rejeita contas de outro cliente (cross-tenant) com 400", async () => {
      const cookie = await login("admin-a");
      const { approvedPost } = await setupAccountsAndPost();

      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules`,
        cookie,
        "POST",
        {
          scheduledLocalTime: "2030-01-01T10:00",
          scheduledTimezone: "America/Cuiaba",
          targetAccountIds: [randomUUID()],
          confirmed: true,
        },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("não pertencem a este cliente");
    });

    it("rejeita conta social com status inativo com 400", async () => {
      const cookie = await login("admin-a");
      const { approvedPost } = await setupAccountsAndPost();

      const inactiveAccount = await migration.socialAccount.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          platform: "FACEBOOK_PAGE",
          platformAccountId: "page_inact_" + randomUUID().substring(0, 8),
          name: "Página Inativa",
          status: "DISCONNECTED",
        },
      });

      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules`,
        cookie,
        "POST",
        {
          scheduledLocalTime: "2030-01-01T10:00",
          scheduledTimezone: "America/Cuiaba",
          targetAccountIds: [inactiveAccount.id],
          confirmed: true,
        },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("estão inativas");
    });

    it("rejeita agendamento no Instagram sem imagem com 400", async () => {
      const cookie = await login("admin-a");
      const { instagramAccount, approvedPost } = await setupAccountsAndPost();

      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules`,
        cookie,
        "POST",
        {
          scheduledLocalTime: "2030-01-01T10:00",
          scheduledTimezone: "America/Cuiaba",
          targetAccountIds: [instagramAccount.id],
          confirmed: true,
        },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain(
        "Instagram exigem a seleção de uma imagem",
      );
    });

    it("rejeita agendamento sem confirmação explícita com 400", async () => {
      const cookie = await login("admin-a");
      const { facebookAccount, approvedPost } = await setupAccountsAndPost();

      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules`,
        cookie,
        "POST",
        {
          scheduledLocalTime: "2030-01-01T10:00",
          scheduledTimezone: "America/Cuiaba",
          targetAccountIds: [facebookAccount.id],
          confirmed: false,
        },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("confirmação explícita");
    });
  });

  // 2. RBAC de Agendamento
  describe("2. RBAC (OWNER, ADMIN, APPROVER, EDITOR, CLIENT_VIEWER)", () => {
    it("permite agendamento por OWNER, ADMIN e APPROVER", async () => {
      for (const roleId of ["owner-a", "admin-a", "approver-a"]) {
        const cookie = await login(roleId);
        const { facebookAccount, approvedPost } = await setupAccountsAndPost();

        const res = await request(
          `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules`,
          cookie,
          "POST",
          {
            scheduledLocalTime: "2030-05-10T14:00",
            scheduledTimezone: "America/Cuiaba",
            targetAccountIds: [facebookAccount.id],
            confirmed: true,
          },
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.status).toBe("ENQUEUED");
        expect(body.scheduledTimezone).toBe("America/Cuiaba");
      }
    });

    it("bloqueia EDITOR e CLIENT_VIEWER com 403", async () => {
      for (const roleId of ["editor-a", "viewer-a"]) {
        const cookie = await login(roleId);
        const { facebookAccount, approvedPost } = await setupAccountsAndPost();

        const res = await request(
          `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules`,
          cookie,
          "POST",
          {
            scheduledLocalTime: "2030-05-10T14:00",
            scheduledTimezone: "America/Cuiaba",
            targetAccountIds: [facebookAccount.id],
            confirmed: true,
          },
        );

        expect(res.status).toBe(403);
      }
    });
  });

  // 3. Timezone America/Cuiaba e conversão UTC
  describe("3. Timezone America/Cuiaba e Persistência de Modelo", () => {
    it("converte horário local de America/Cuiaba (UTC-4) para UTC corretamente e persiste jobId determinístico", async () => {
      const cookie = await login("admin-a");
      const { facebookAccount, approvedPost } = await setupAccountsAndPost();

      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules`,
        cookie,
        "POST",
        {
          scheduledLocalTime: "2030-06-15T10:00",
          scheduledTimezone: "America/Cuiaba",
          targetAccountIds: [facebookAccount.id],
          confirmed: true,
        },
      );

      expect(res.status).toBe(201);
      const sched = await res.json();

      expect(sched.scheduledTimezone).toBe("America/Cuiaba");
      expect(sched.scheduledLocalTime).toBe("2030-06-15T10:00");
      // 10:00 em Cuiabá (UTC-4) deve ser exatamente 14:00Z
      expect(sched.scheduledForUtc).toBe("2030-06-15T14:00:00.000Z");
      expect(sched.jobId).toBe(`sched:${sched.id}:v1`);
      expect(sched.status).toBe("ENQUEUED");

      // Verifica auditoria
      const audit = await migration.auditLog.findFirst({
        where: {
          organizationId: "org-a",
          entityId: sched.id,
          action: "schedule.created",
        },
      });
      expect(audit).not.toBeNull();
      expect(audit?.action).toBe("schedule.created");
    });
  });

  // 4. Reprogramação e Cancelamento
  describe("4. Reprogramação e Cancelamento com Invalidação de Versão", () => {
    it("reprograma data/hora incrementando versão e atualizando BullMQ job", async () => {
      const cookie = await login("admin-a");
      const { facebookAccount, approvedPost } = await setupAccountsAndPost();

      // Cria agendamento inicial v1
      const resCreate = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules`,
        cookie,
        "POST",
        {
          scheduledLocalTime: "2030-06-15T10:00",
          scheduledTimezone: "America/Cuiaba",
          targetAccountIds: [facebookAccount.id],
          confirmed: true,
        },
      );
      expect(resCreate.status).toBe(201);
      const initial = await resCreate.json();
      expect(initial.version).toBe(1);

      // Reprograma para v2
      const resResched = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules/${initial.id}/reschedule`,
        cookie,
        "POST",
        {
          scheduledLocalTime: "2030-07-20T16:00",
          scheduledTimezone: "America/Cuiaba",
          confirmed: true,
        },
      );
      expect(resResched.status).toBe(200);
      const updated = await resResched.json();

      expect(updated.version).toBe(2);
      expect(updated.scheduledLocalTime).toBe("2030-07-20T16:00");
      expect(updated.scheduledForUtc).toBe("2030-07-20T20:00:00.000Z");
      expect(updated.jobId).toBe(`sched:${initial.id}:v2`);

      // Audit log de reschedule
      const auditResched = await migration.auditLog.findFirst({
        where: {
          organizationId: "org-a",
          entityId: initial.id,
          action: "schedule.rescheduled",
        },
      });
      expect(auditResched).not.toBeNull();
    });

    it("cancela agendamento antes da execução e remove do BullMQ", async () => {
      const cookie = await login("admin-a");
      const { facebookAccount, approvedPost } = await setupAccountsAndPost();

      const resCreate = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules`,
        cookie,
        "POST",
        {
          scheduledLocalTime: "2030-08-01T12:00",
          scheduledTimezone: "America/Cuiaba",
          targetAccountIds: [facebookAccount.id],
          confirmed: true,
        },
      );
      expect(resCreate.status).toBe(201);
      const sched = await resCreate.json();

      const resCancel = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules/${sched.id}/cancel`,
        cookie,
        "POST",
        {
          reason: "Cancelado pelo usuário nos testes",
        },
      );
      expect(resCancel.status).toBe(200);
      const cancelled = await resCancel.json();
      expect(cancelled.status).toBe("CANCELLED");
      expect(cancelled.cancellationReason).toBe(
        "Cancelado pelo usuário nos testes",
      );

      // Audit log de cancel
      const auditCancel = await migration.auditLog.findFirst({
        where: {
          organizationId: "org-a",
          entityId: sched.id,
          action: "schedule.cancelled",
        },
      });
      expect(auditCancel).not.toBeNull();
    });

    it("rejeita cancelamento se agendamento já estiver em PROCESSING", async () => {
      const cookie = await login("admin-a");
      const { facebookAccount, approvedPost } = await setupAccountsAndPost();

      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2030-08-01T12:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: new Date("2030-08-01T16:00:00Z"),
          status: "PROCESSING",
          jobId: "sched:proc_cancel_test:v1",
          createdById: "admin-a",
        },
      });

      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules/${sched.id}/cancel`,
        cookie,
        "POST",
        { reason: "Tentativa de cancelar em processamento" },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.message).toContain("já está em processamento");
    });
  });

  // 5. Execução do Worker e Tolerância a Atraso
  describe("5. Execução do Worker, Tolerância a Atraso e Sucesso na Publicação", () => {
    it("executa com sucesso via worker quando no horário e atualiza status para PUBLISHED", async () => {
      const { facebookAccount, approvedPost, media } =
        await setupAccountsAndPost();

      const now = new Date();
      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          mediaAssetId: media.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2026-09-20T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: now,
          status: "ENQUEUED",
          jobId: "sched:test_exec_1:v1",
          createdById: "admin-a",
          version: 1,
        },
      });

      await processScheduleJob(
        {
          id: sched.jobId,
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1,
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: mockPublisher,
        },
      );

      const updatedSched = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(updatedSched?.status).toBe("PUBLISHED");

      // Verifica que o PublicationAttempt foi criado e associado ao schedule
      const attempt = await migration.publicationAttempt.findFirst({
        where: {
          postId: approvedPost.id,
          socialAccountId: facebookAccount.id,
          scheduleId: sched.id,
        },
      });
      expect(attempt).not.toBeNull();
      expect(attempt?.status).toBe("PUBLISHED");
      expect(attempt?.remoteMediaId).toBeDefined();

      // Verifica auditoria de schedule.published
      const audit = await migration.auditLog.findFirst({
        where: {
          organizationId: "org-a",
          entityId: sched.id,
          action: "schedule.published",
        },
      });
      expect(audit).not.toBeNull();
    });

    it("worker ignora job com versão obsoleta após reprogramação", async () => {
      const { facebookAccount, approvedPost } = await setupAccountsAndPost();

      // Schedule com versão 2
      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2030-08-01T12:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: new Date(),
          status: "ENQUEUED",
          jobId: "sched:test_obsolete:v2",
          createdById: "admin-a",
          version: 2,
        },
      });

      // Envia job da versão 1 (obsoleta)
      await processScheduleJob(
        {
          id: "sched:test_obsolete:v1",
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1, // versão antiga
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: mockPublisher,
        },
      );

      // Schedule continua ENQUEUED na v2, não foi executado
      const currentSched = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(currentSched?.status).toBe("ENQUEUED");
      expect(currentSched?.version).toBe(2);

      // Nenhuma tentativa criada
      const attempts = await migration.publicationAttempt.findMany({
        where: { postId: approvedPost.id },
      });
      expect(attempts).toHaveLength(0);
    });

    it("política de atraso: atraso até 15 minutos executa normalmente", async () => {
      const { facebookAccount, approvedPost, media } =
        await setupAccountsAndPost();

      // Agendado para 10 minutos atrás
      const scheduledTime = new Date(Date.now() - 10 * 60 * 1000);
      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          mediaAssetId: media.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2026-09-20T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: scheduledTime,
          status: "ENQUEUED",
          jobId: "sched:late_10m:v1",
          createdById: "admin-a",
          version: 1,
        },
      });

      await processScheduleJob(
        {
          id: sched.jobId,
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1,
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: mockPublisher,
        },
      );

      const updated = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(updated?.status).toBe("PUBLISHED");
    });

    it("política de atraso: atraso superior a 15 minutos marca REQUIRES_RECONCILIATION sem publicar automaticamente", async () => {
      const { facebookAccount, approvedPost } = await setupAccountsAndPost();

      // Agendado para 25 minutos atrás (> 15 min de tolerância)
      const scheduledTime = new Date(Date.now() - 25 * 60 * 1000);
      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2026-09-20T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: scheduledTime,
          status: "ENQUEUED",
          jobId: "sched:late_25m:v1",
          createdById: "admin-a",
          version: 1,
        },
      });

      await processScheduleJob(
        {
          id: sched.jobId,
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1,
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: mockPublisher,
        },
      );

      const updated = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(updated?.status).toBe("REQUIRES_RECONCILIATION");
      expect(updated?.failureReason).toContain(
        "Atraso de execução superior a 15 minutos",
      );

      // Zero tentativas de publicação foram efetuadas
      const attempts = await migration.publicationAttempt.findMany({
        where: { postId: approvedPost.id },
      });
      expect(attempts).toHaveLength(0);

      // Auditoria de reconciliação requerida
      const audit = await migration.auditLog.findFirst({
        where: {
          organizationId: "org-a",
          entityId: sched.id,
          action: "schedule.reconciliation_required",
        },
      });
      expect(audit).not.toBeNull();
    });
  });

  // 6. Concorrência, Re-entrega e Idempotência
  describe("6. Concorrência entre Workers, Re-entrega e Idempotência", () => {
    it("dois workers concorrentes no mesmo agendamento não duplicam publicações", async () => {
      const { facebookAccount, approvedPost, media } =
        await setupAccountsAndPost();

      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          mediaAssetId: media.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2026-09-20T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: new Date(),
          status: "ENQUEUED",
          jobId: "sched:concurrent_test:v1",
          createdById: "admin-a",
          version: 1,
        },
      });

      // Dispara dois workers concorrentemente
      await Promise.all([
        processScheduleJob(
          {
            id: sched.jobId,
            data: {
              scheduleId: sched.id,
              postId: approvedPost.id,
              organizationId: "org-a",
              clientId: "client-a",
              version: 1,
            },
          },
          migrationClient,
          redis,
          appConfig,
          {
            publisher: mockPublisher,
          },
        ),
        processScheduleJob(
          {
            id: sched.jobId,
            data: {
              scheduleId: sched.id,
              postId: approvedPost.id,
              organizationId: "org-a",
              clientId: "client-a",
              version: 1,
            },
          },
          migrationClient,
          redis,
          appConfig,
          {
            publisher: mockPublisher,
          },
        ),
      ]);

      // Exatamente um PublicationAttempt foi criado
      const attempts = await migration.publicationAttempt.findMany({
        where: {
          postId: approvedPost.id,
          socialAccountId: facebookAccount.id,
        },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("PUBLISHED");

      const finalSched = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(finalSched?.status).toBe("PUBLISHED");
    });

    it("dois workers concorrentes com barreira determinística pré-aquisição: exatamente um adquire via CAS e perdedor não altera estado final", async () => {
      const { facebookAccount, approvedPost, media } =
        await setupAccountsAndPost();

      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          mediaAssetId: media.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2026-09-20T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: new Date(),
          status: "ENQUEUED",
          jobId: `sched:cas_barrier_${randomUUID()}:v1`,
          createdById: "admin-a",
          version: 1,
        },
      });

      let w1ReachedBarrier = false;
      let w2ReachedBarrier = false;
      let releaseW1!: () => void;
      let releaseW2!: () => void;
      const w1ProceedPromise = new Promise<void>((r) => {
        releaseW1 = r;
      });
      const w2ProceedPromise = new Promise<void>((r) => {
        releaseW2 = r;
      });

      let metaFeedCalls = 0;
      const trackedPublisher = new MetaPublisherAdapter({
        graphBaseUrl: metaMock.url,
        pollDelayMs: 10,
        pollMaxAttempts: 5,
        fetchFn: async (url, init) => {
          if (
            String(url).includes("/feed") ||
            String(url).includes("/photos")
          ) {
            metaFeedCalls++;
          }
          return fetch(url, init);
        },
      });

      const worker1Promise = processScheduleJob(
        {
          id: sched.jobId,
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1,
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: trackedPublisher,
          onBeforeAcquisition: async () => {
            w1ReachedBarrier = true;
            while (!w2ReachedBarrier) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await w1ProceedPromise;
          },
        },
      );

      const worker2Promise = processScheduleJob(
        {
          id: sched.jobId,
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1,
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: trackedPublisher,
          onBeforeAcquisition: async () => {
            w2ReachedBarrier = true;
            while (!w1ReachedBarrier) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await w2ProceedPromise;
          },
        },
      );

      // Espera ambos os workers atingirem a barreira simultaneamente
      while (!w1ReachedBarrier || !w2ReachedBarrier) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Libera ambos os workers
      releaseW1();
      releaseW2();

      const [res1, res2] = await Promise.all([worker1Promise, worker2Promise]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual(["published", "skipped_not_acquired"]);

      // Exatamente uma chamada remota à Meta
      expect(metaFeedCalls).toBe(1);

      // Exatamente um PublicationAttempt criado
      const attempts = await migration.publicationAttempt.findMany({
        where: {
          postId: approvedPost.id,
          socialAccountId: facebookAccount.id,
        },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("PUBLISHED");

      // Apenas um schedule.started registrado, pelo ator técnico do sistema
      const startedLogs = await migration.auditLog.findMany({
        where: {
          entityId: sched.id,
          action: "schedule.started",
        },
      });
      expect(startedLogs).toHaveLength(1);
      expect(startedLogs[0]?.actorUserId).toBe("system:scheduler");

      // Perdedor não alterou o estado final PUBLISHED
      const finalSched = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(finalSched?.status).toBe("PUBLISHED");
    });

    it("cancelamento vence imediatamente antes da aquisição: worker é impedido e não publica", async () => {
      const { facebookAccount, approvedPost, media } =
        await setupAccountsAndPost();

      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          mediaAssetId: media.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2026-09-20T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: new Date(),
          status: "ENQUEUED",
          jobId: `sched:cancel_race_${randomUUID()}:v1`,
          createdById: "admin-a",
          version: 1,
        },
      });

      let reachedAcquisition = false;
      let releaseWorker!: () => void;
      const workerProceed = new Promise<void>((r) => {
        releaseWorker = r;
      });

      const workerPromise = processScheduleJob(
        {
          id: sched.jobId,
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1,
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: mockPublisher,
          onBeforeAcquisition: async () => {
            reachedAcquisition = true;
            await workerProceed;
          },
        },
      );

      while (!reachedAcquisition) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Executa cancelamento concorrente
      const adminCookie = await login("admin-a");
      const cancelRes = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules/${sched.id}/cancel`,
        adminCookie,
        "POST",
        { reason: "Cancelamento prioritário" },
      );
      expect(cancelRes.status).toBe(200);

      // Libera worker para tentar CAS
      releaseWorker();
      const workerResult = await workerPromise;

      expect(["skipped_cancelled", "skipped_not_acquired"]).toContain(
        workerResult.status,
      );

      const finalSched = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(finalSched?.status).toBe("CANCELLED");

      const attempts = await migration.publicationAttempt.findMany({
        where: { postId: approvedPost.id },
      });
      expect(attempts).toHaveLength(0);
    });

    it("worker vence imediatamente antes do cancelamento: cancelamento retorna 409", async () => {
      const { facebookAccount, approvedPost, media } =
        await setupAccountsAndPost();

      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          mediaAssetId: media.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2026-09-20T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: new Date(),
          status: "ENQUEUED",
          jobId: `sched:worker_race_${randomUUID()}:v1`,
          createdById: "admin-a",
          version: 1,
        },
      });

      let reachedPublish = false;
      let releaseWorker!: () => void;
      const workerProceed = new Promise<void>((r) => {
        releaseWorker = r;
      });

      const workerPromise = processScheduleJob(
        {
          id: sched.jobId,
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1,
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: mockPublisher,
          onBeforePublish: async () => {
            reachedPublish = true;
            await workerProceed;
          },
        },
      );

      while (!reachedPublish) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Tenta cancelar enquanto worker está em PROCESSING
      const adminCookie = await login("admin-a");
      const cancelRes = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules/${sched.id}/cancel`,
        adminCookie,
        "POST",
        { reason: "Tentativa concorrente" },
      );
      expect(cancelRes.status).toBe(409);
      const cancelBody = await cancelRes.json();
      expect(cancelBody.message).toContain("já está em processamento");

      // Libera worker para finalizar publicação
      releaseWorker();
      const workerResult = await workerPromise;
      expect(workerResult.status).toBe("published");

      const finalSched = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(finalSched?.status).toBe("PUBLISHED");
    });

    it("reprogramação vence antes da aquisição da versão antiga: versão antiga é ignorada e não sobrescreve nova versão", async () => {
      const { facebookAccount, approvedPost, media } =
        await setupAccountsAndPost();

      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          mediaAssetId: media.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2026-09-20T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: new Date(),
          status: "ENQUEUED",
          jobId: `sched:resched_race_${randomUUID()}:v1`,
          createdById: "admin-a",
          version: 1,
        },
      });

      let reachedAcquisition = false;
      let releaseWorker!: () => void;
      const workerProceed = new Promise<void>((r) => {
        releaseWorker = r;
      });

      const workerPromise = processScheduleJob(
        {
          id: sched.jobId,
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1,
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: mockPublisher,
          onBeforeAcquisition: async () => {
            reachedAcquisition = true;
            await workerProceed;
          },
        },
      );

      while (!reachedAcquisition) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Reprograma via endpoint autenticado para nova versão v2
      const adminCookie = await login("admin-a");
      const reschedRes = await request(
        `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/schedules/${sched.id}/reschedule`,
        adminCookie,
        "POST",
        {
          scheduledTimezone: "America/Cuiaba",
          scheduledLocalTime: "2030-01-01T15:00",
          confirmed: true,
        },
      );
      expect(reschedRes.status).toBe(200);
      const reschedBody = await reschedRes.json();
      expect(reschedBody.version).toBe(2);

      // Libera worker antigo (v1)
      releaseWorker();
      const workerResult = await workerPromise;

      expect(["skipped_obsolete_version", "skipped_not_acquired"]).toContain(
        workerResult.status,
      );

      const finalSched = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(finalSched?.version).toBe(2);
      expect(finalSched?.status).toBe("ENQUEUED");

      const attempts = await migration.publicationAttempt.findMany({
        where: { postId: approvedPost.id },
      });
      expect(attempts).toHaveLength(0);
    });

    it("retry antigo não sobrescreve estado terminal protegido", async () => {
      const { facebookAccount, approvedPost, media } =
        await setupAccountsAndPost();

      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          mediaAssetId: media.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2026-09-20T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: new Date(),
          status: "PUBLISHED",
          jobId: `sched:terminal_prot_${randomUUID()}:v1`,
          createdById: "admin-a",
          version: 1,
        },
      });

      const res = await processScheduleJob(
        {
          id: sched.jobId,
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1,
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: mockPublisher,
        },
      );

      expect(res.status).toBe("skipped_already_terminal");

      const check = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(check?.status).toBe("PUBLISHED");
    });

    it("usuário criador desativado antes da execução: worker conclui com sucesso via ator técnico do sistema", async () => {
      const { facebookAccount, approvedPost, media } =
        await setupAccountsAndPost();

      await migration.user.update({
        where: { id: "admin-a" },
        data: { active: false },
      });

      try {
        const sched = await migration.publicationSchedule.create({
          data: {
            organizationId: "org-a",
            clientId: "client-a",
            postId: approvedPost.id,
            mediaAssetId: media.id,
            targetAccountIds: [facebookAccount.id],
            scheduledLocalTime: "2026-09-20T10:00",
            scheduledTimezone: "America/Cuiaba",
            scheduledForUtc: new Date(),
            status: "ENQUEUED",
            jobId: `sched:inactive_creator_${randomUUID()}:v1`,
            createdById: "admin-a",
            version: 1,
          },
        });

        const res = await processScheduleJob(
          {
            id: sched.jobId,
            data: {
              scheduleId: sched.id,
              postId: approvedPost.id,
              organizationId: "org-a",
              clientId: "client-a",
              version: 1,
            },
          },
          migrationClient,
          redis,
          appConfig,
          {
            publisher: mockPublisher,
          },
        );

        expect(res.status).toBe("published");

        const updatedSched = await migration.publicationSchedule.findUnique({
          where: { id: sched.id },
        });
        expect(updatedSched?.status).toBe("PUBLISHED");
        expect(updatedSched?.createdById).toBe("admin-a"); // Autor original preservado

        const attempt = await migration.publicationAttempt.findFirst({
          where: {
            postId: approvedPost.id,
            socialAccountId: facebookAccount.id,
          },
        });
        expect(attempt?.status).toBe("PUBLISHED");

        const startedLog = await migration.auditLog.findFirst({
          where: { entityId: sched.id, action: "schedule.started" },
        });
        expect(startedLog?.actorUserId).toBe("system:scheduler"); // Identidade técnica registrada
      } finally {
        await migration.user.update({
          where: { id: "admin-a" },
          data: { active: true },
        });
      }
    });

    it("associação do criador removida antes da execução: worker conclui com sucesso", async () => {
      const { facebookAccount, approvedPost, media } =
        await setupAccountsAndPost();

      const savedMemberships = await migration.membership.findMany({
        where: { userId: "admin-a" },
      });
      await migration.membership.deleteMany({
        where: { userId: "admin-a" },
      });

      try {
        const sched = await migration.publicationSchedule.create({
          data: {
            organizationId: "org-a",
            clientId: "client-a",
            postId: approvedPost.id,
            mediaAssetId: media.id,
            targetAccountIds: [facebookAccount.id],
            scheduledLocalTime: "2026-09-20T10:00",
            scheduledTimezone: "America/Cuiaba",
            scheduledForUtc: new Date(),
            status: "ENQUEUED",
            jobId: `sched:no_membership_${randomUUID()}:v1`,
            createdById: "admin-a",
            version: 1,
          },
        });

        const res = await processScheduleJob(
          {
            id: sched.jobId,
            data: {
              scheduleId: sched.id,
              postId: approvedPost.id,
              organizationId: "org-a",
              clientId: "client-a",
              version: 1,
            },
          },
          migrationClient,
          redis,
          appConfig,
          {
            publisher: mockPublisher,
          },
        );

        expect(res.status).toBe("published");

        const updatedSched = await migration.publicationSchedule.findUnique({
          where: { id: sched.id },
        });
        expect(updatedSched?.status).toBe("PUBLISHED");
      } finally {
        for (const m of savedMemberships) {
          await migration.membership.create({
            data: {
              id: m.id,
              userId: m.userId,
              organizationId: m.organizationId,
              clientId: m.clientId,
              role: m.role,
              active: m.active,
            },
          });
        }
      }
    });

    it("isolamento estrito entre tenants: identidade técnica do Tenant A não acessa registros do Tenant B", async () => {
      const { asSchedulerActor } =
        await import("../../packages/db/src/index.js");

      await asSchedulerActor(
        db,
        { organizationId: "org-a", clientId: "client-a" },
        async (tx) => {
          const crossPosts = await tx.post.findMany({
            where: { organizationId: "org-b" },
          });
          expect(crossPosts).toHaveLength(0); // RLS garante isolamento multitenant

          const crossSchedules = await tx.publicationSchedule.findMany({
            where: { organizationId: "org-b" },
          });
          expect(crossSchedules).toHaveLength(0);
        },
      );
    });

    it("ciclo de vida explícito da fila BullMQ sem singleton global", async () => {
      const { createScheduleQueue, closeScheduleQueue } =
        (await import("../../apps/api/dist/scheduler-queue.js")) as unknown as typeof import("../../apps/api/src/scheduler-queue.js");

      const customRedis = new Redis(process.env.REDIS_URL!, {
        maxRetriesPerRequest: 1,
      });

      const q1 = createScheduleQueue(customRedis);
      const q2 = createScheduleQueue(customRedis);

      expect(q1).not.toBe(q2); // Instâncias isoladas sem singleton global

      await closeScheduleQueue(q1);
      await closeScheduleQueue(q2);
      customRedis.disconnect();
    });

    it("reentrega do mesmo job (replay) é segura e ignora destinos já publicados", async () => {
      const { facebookAccount, approvedPost, media } =
        await setupAccountsAndPost();

      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          mediaAssetId: media.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2026-09-20T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: new Date(),
          status: "ENQUEUED",
          jobId: "sched:replay_test:v1",
          createdById: "admin-a",
          version: 1,
        },
      });

      // Primeira execução
      await processScheduleJob(
        {
          id: sched.jobId,
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1,
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: mockPublisher,
        },
      );

      // Segunda execução (reentrega do mesmo job)
      await processScheduleJob(
        {
          id: sched.jobId,
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1,
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: mockPublisher,
        },
      );

      // Deve existir apenas 1 tentativa
      const attempts = await migration.publicationAttempt.findMany({
        where: {
          postId: approvedPost.id,
          socialAccountId: facebookAccount.id,
        },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.attemptNumber).toBe(1);
    });
  });

  // 7. Retries, Erros Transitórios vs Permanentes e Dead-Letter
  describe("7. Retries, Erros Transitórios vs Permanentes e Dead-Letter", () => {
    it("não repete em erro permanente e marca status FAILED / DEAD_LETTER", async () => {
      const { facebookAccount, approvedPost, media } =
        await setupAccountsAndPost();

      // Altera o token no DB para um token que o MetaMock rejeita permanentemente como OAuthException inválido
      const fbContext = {
        organizationId: "org-a",
        clientId: "client-a",
        platformAccountId: facebookAccount.platformAccountId,
        keyVersion: 1,
      };
      const invalidToken = cryptoHelper.encrypt(
        "invalid_or_expired_token",
        fbContext,
      );
      await migration.oAuthCredential.update({
        where: { socialAccountId: facebookAccount.id },
        data: {
          encryptedAccessToken: invalidToken.encryptedAccessToken,
          iv: invalidToken.iv,
          authTag: invalidToken.authTag,
        },
      });

      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          mediaAssetId: media.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2026-09-20T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: new Date(),
          status: "ENQUEUED",
          jobId: "sched:perm_fail_test:v1",
          createdById: "admin-a",
          version: 1,
        },
      });

      await processScheduleJob(
        {
          id: sched.jobId,
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1,
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: mockPublisher,
        },
      );

      const updated = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(updated?.status).toBe("DEAD_LETTER");
      expect(updated?.failureReason).toBeDefined();

      // Tentativa de publicação deve estar marcada como FAILED
      const attempt = await migration.publicationAttempt.findFirst({
        where: { postId: approvedPost.id, socialAccountId: facebookAccount.id },
      });
      expect(attempt?.status).toBe("FAILED");
    });

    it("sucesso parcial: uma conta falha e outra sucede, marcando PARTIALLY_PUBLISHED", async () => {
      const { facebookAccount, instagramAccount, approvedPost, media } =
        await setupAccountsAndPost();

      // Facebook com token inválido permanente
      const fbContext = {
        organizationId: "org-a",
        clientId: "client-a",
        platformAccountId: facebookAccount.platformAccountId,
        keyVersion: 1,
      };
      const invalidToken = cryptoHelper.encrypt(
        "invalid_or_expired_token",
        fbContext,
      );
      await migration.oAuthCredential.update({
        where: { socialAccountId: facebookAccount.id },
        data: {
          encryptedAccessToken: invalidToken.encryptedAccessToken,
          iv: invalidToken.iv,
          authTag: invalidToken.authTag,
        },
      });
      // Instagram mantém token válido

      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          mediaAssetId: media.id,
          targetAccountIds: [facebookAccount.id, instagramAccount.id],
          scheduledLocalTime: "2026-09-20T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: new Date(),
          status: "ENQUEUED",
          jobId: "sched:partial_test:v1",
          createdById: "admin-a",
          version: 1,
        },
      });

      await processScheduleJob(
        {
          id: sched.jobId,
          data: {
            scheduleId: sched.id,
            postId: approvedPost.id,
            organizationId: "org-a",
            clientId: "client-a",
            version: 1,
          },
        },
        migrationClient,
        redis,
        appConfig,
        {
          publisher: mockPublisher,
        },
      );

      const updated = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(updated?.status).toBe("PARTIALLY_PUBLISHED");

      // Facebook falhou
      const fbAttempt = await migration.publicationAttempt.findFirst({
        where: { postId: approvedPost.id, socialAccountId: facebookAccount.id },
      });
      expect(fbAttempt?.status).toBe("FAILED");

      // Instagram sucedeu
      const igAttempt = await migration.publicationAttempt.findFirst({
        where: {
          postId: approvedPost.id,
          socialAccountId: instagramAccount.id,
        },
      });
      expect(igAttempt?.status).toBe("PUBLISHED");

      // Auditoria
      const audit = await migration.auditLog.findFirst({
        where: {
          organizationId: "org-a",
          entityId: sched.id,
          action: "schedule.partially_published",
        },
      });
      expect(audit).not.toBeNull();
    });
  });

  // 8. Recuperação na Inicialização (Startup Reconciliation)
  describe("8. Rotina de Recuperação e Reconciliação (Startup Reconciliation)", () => {
    it("recupera agendamento persistido sem job BullMQ correspondente", async () => {
      const { facebookAccount, approvedPost } = await setupAccountsAndPost();

      // Cria agendamento no DB com status SCHEDULED e sem job no BullMQ
      const futureDate = new Date(Date.now() + 3600 * 1000);
      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2030-01-01T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: futureDate,
          status: "SCHEDULED",
          jobId: `sched:${randomUUID()}:v1`,
          createdById: "admin-a",
          version: 1,
        },
      });

      const res = await runStartupReconciliation(migrationClient, redis);
      expect(res.recoveredJobs).toBeGreaterThanOrEqual(1);

      const updated = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(updated?.status).toBe("ENQUEUED");
    });

    it("recupera execução com lease expirada em PROCESSING marcando REQUIRES_RECONCILIATION", async () => {
      const { facebookAccount, approvedPost } = await setupAccountsAndPost();

      // Cria agendamento travado em PROCESSING há mais de 10 minutos
      const pastTime = new Date(Date.now() - 600 * 1000);
      const sched = await migration.publicationSchedule.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: approvedPost.id,
          targetAccountIds: [facebookAccount.id],
          scheduledLocalTime: "2026-09-20T10:00",
          scheduledTimezone: "America/Cuiaba",
          scheduledForUtc: pastTime,
          status: "PROCESSING",
          jobId: "sched:stalled_lease:v1",
          createdById: "admin-a",
          version: 1,
          updatedAt: pastTime,
        },
      });

      const res = await runStartupReconciliation(migrationClient, redis);
      expect(res.flaggedOrphan).toBeGreaterThanOrEqual(1);

      const updated = await migration.publicationSchedule.findUnique({
        where: { id: sched.id },
      });
      expect(updated?.status).toBe("REQUIRES_RECONCILIATION");
      expect(updated?.failureReason).toContain("reconciliação manual");
    });
  });
});
