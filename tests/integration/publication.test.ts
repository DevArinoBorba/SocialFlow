import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import {
  createDatabase,
  createCredentialCrypto,
  type CredentialContext,
} from "../../packages/db/src/index.js";
import { readConfig } from "../../packages/config/src/index.js";
// @ts-expect-error dist output does not emit d.ts
import { createApplication } from "../../apps/api/dist/app.js";
import {
  startMetaMockServer,
  type MetaMockServer,
} from "../helpers/meta-mock.js";
// @ts-expect-error dist output does not emit d.ts
import { MetaPublisherAdapter } from "../../apps/api/dist/meta-publisher.js";
// @ts-expect-error dist output does not emit d.ts
import { createPublicMediaTicket } from "../../apps/api/dist/media-ticket.js";

const db = createDatabase(process.env.DATABASE_URL!);
const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);
const TEST_KEY_32 = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const cryptoHelper = createCredentialCrypto(TEST_KEY_32);

beforeAll(async () => {
  await db.$connect();
  await migration.$connect();
});

afterAll(async () => {
  await db.$disconnect();
  await migration.$disconnect();
});

describe("Incremento Fase 3: Publicação Manual Controlada na Meta", () => {
  let metaMock: MetaMockServer;
  let redis: Redis;
  let appRuntime: Awaited<ReturnType<typeof createApplication>>;
  let apiBase: string;
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

  let onBeforePublishHook: (() => Promise<void>) | undefined;
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
    metaMock = await startMetaMockServer();
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });

    const config = readConfig({
      ...process.env,
      META_APP_ID: "meta-test-app-id",
      META_APP_SECRET: "meta-test-app-secret",
      META_GRAPH_URL: metaMock.url,
      CREDENTIAL_MASTER_KEY: TEST_KEY_32.toString("hex"),
    });

    const mockPublisher = new MetaPublisherAdapter({
      graphBaseUrl: metaMock.url,
      pollDelayMs: 10,
      pollMaxAttempts: 5,
    });

    appRuntime = await createApplication(config, {
      publicationDependencies: {
        publisher: mockPublisher,
        masterKey: TEST_KEY_32,
        onBeforePublish: async () => {
          if (onBeforePublishHook) {
            await onBeforePublishHook();
          }
        },
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
    await migration.oAuthCredential.deleteMany({});
    await migration.socialAccount.deleteMany({});
    await migration.post.deleteMany({});
    await migration.mediaAsset.deleteMany({});

    redis.disconnect();
    await appRuntime.close();
    await metaMock.close();
  });

  beforeEach(async () => {
    await migration.rateLimit.deleteMany();
    onBeforePublishHook = undefined;
    mockStorageMap.clear();
  });

  it("bloqueia publicação de post com status diferente de APPROVED (DRAFT, IN_REVIEW, REJECTED) com 422", async () => {
    const cookie = await login("admin-a");

    const draftPost = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Post em rascunho",
        status: "DRAFT",
      },
    });

    const res = await request(
      `/api/organizations/org-a/clients/client-a/posts/${draftPost.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [randomUUID()],
        idempotencyKey: "idem_draft_test_123",
      },
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.message).toContain("status APROVADO");
  });

  it("bloqueia publicação se contas sociais selecionadas não pertencem ao cliente", async () => {
    const cookie = await login("admin-a");

    const approvedPost = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Post aprovado",
        status: "APPROVED",
      },
    });

    // Tentativa com ID inexistente ou pertencente a outro tenant
    const res = await request(
      `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [randomUUID()],
        idempotencyKey: "idem_other_client_123",
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain("não pertencem a este cliente");
  });

  it("bloqueia publicação no Instagram se nenhuma imagem for selecionada", async () => {
    const cookie = await login("admin-a");

    const approvedPost = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Post aprovado para IG sem imagem",
        status: "APPROVED",
      },
    });

    const igAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "INSTAGRAM_BUSINESS",
        platformAccountId: "ig_acc_999",
        name: "Instagram Teste",
        status: "ACTIVE",
      },
    });

    const res = await request(
      `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [igAccount.id],
        idempotencyKey: "idem_ig_no_img_123",
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain("Instagram exigem a seleção de uma imagem");
  });

  it("publica com sucesso em Página do Facebook com imagem e texto, registrando PublicationAttempt e AuditLog", async () => {
    const cookie = await login("admin-a");

    // 1. Cria conta social FB com credencial criptografada
    const fbAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: "fb_page_888",
        name: "Página FB Teste",
        status: "ACTIVE",
      },
    });

    const context: CredentialContext = {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: "fb_page_888",
      keyVersion: 1,
    };
    const encrypted = cryptoHelper.encrypt("valid_meta_page_token", context);

    await migration.oAuthCredential.create({
      data: {
        socialAccountId: fbAccount.id,
        encryptedAccessToken: encrypted.encryptedAccessToken,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: 1,
        tokenType: "PAGE_ACCESS_TOKEN",
      },
    });

    // 2. Cria imagem na biblioteca pronta
    const mediaId = randomUUID();
    const media = await migration.mediaAsset.create({
      data: {
        id: mediaId,
        organizationId: "org-a",
        clientId: "client-a",
        name: "Foto Lançamento",
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

    // 3. Cria post APPROVED
    const post = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Confira nosso novo lançamento!",
        hashtags: "#novidade #socialflow",
        status: "APPROVED",
      },
    });

    // 4. Executa publicação
    const idempotencyKey = "idem_fb_success_456";
    const res = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        mediaAssetId: media.id,
        idempotencyKey,
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0].status).toBe("PUBLISHED");
    expect(body.attempts[0].remoteMediaId).toBe("fb_post_mock_67890");
    expect(body.attempts[0].remotePermalink).toBe(
      "https://www.facebook.com/fb_post_mock_67890",
    );

    // 5. Verifica gravação no banco de dados
    const savedAttempt = await migration.publicationAttempt.findFirst({
      where: { postId: post.id, socialAccountId: fbAccount.id },
    });
    expect(savedAttempt).not.toBeNull();
    expect(savedAttempt?.status).toBe("PUBLISHED");
    expect(savedAttempt?.remoteMediaId).toBe("fb_post_mock_67890");
    expect(savedAttempt?.attemptNumber).toBe(1);

    // 6. Verifica AuditLog
    const auditEntry = await migration.auditLog.findFirst({
      where: { entityId: savedAttempt!.id, action: "post.published" },
    });
    expect(auditEntry).not.toBeNull();

    // 7. Teste de idempotência: segunda chamada com a mesma chave retorna resultado em cache
    const resIdem = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        mediaAssetId: media.id,
        idempotencyKey,
      },
    );
    expect(resIdem.status).toBe(200);
    const bodyIdem = await resIdem.json();
    expect(bodyIdem.success).toBe(true);
    // Garante que não criou uma segunda tentativa no banco
    const allAttempts = await migration.publicationAttempt.findMany({
      where: { postId: post.id, socialAccountId: fbAccount.id },
    });
    expect(allAttempts).toHaveLength(1);
  });

  it("trata falha parcial entre contas (FB ok, IG com token expirado marcado como EXPIRED)", async () => {
    const cookie = await login("admin-a");

    // Conta Facebook válida
    const fbAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: "fb_page_partial_1",
        name: "Página FB Parcial",
        status: "ACTIVE",
      },
    });
    const fbEnc = cryptoHelper.encrypt("valid_token", {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: "fb_page_partial_1",
      keyVersion: 1,
    });
    await migration.oAuthCredential.create({
      data: {
        socialAccountId: fbAccount.id,
        encryptedAccessToken: fbEnc.encryptedAccessToken,
        iv: fbEnc.iv,
        authTag: fbEnc.authTag,
        keyVersion: 1,
      },
    });

    // Conta Instagram com token que o mock rejeita como expirado (code 190)
    const igAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "INSTAGRAM_BUSINESS",
        platformAccountId: "ig_acc_expired_2",
        name: "Instagram Expirado",
        status: "ACTIVE",
      },
    });
    const igEnc = cryptoHelper.encrypt("invalid_or_expired_token", {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: "ig_acc_expired_2",
      keyVersion: 1,
    });
    await migration.oAuthCredential.create({
      data: {
        socialAccountId: igAccount.id,
        encryptedAccessToken: igEnc.encryptedAccessToken,
        iv: igEnc.iv,
        authTag: igEnc.authTag,
        keyVersion: 1,
      },
    });

    const mediaId2 = randomUUID();
    const media = await migration.mediaAsset.create({
      data: {
        id: mediaId2,
        organizationId: "org-a",
        clientId: "client-a",
        name: "Foto Parcial",
        storageKey: `media/org-a/client-a/${mediaId2}`,
        status: "ready",
        mimeType: "image/jpeg",
        byteSize: 5000,
        width: 1080,
        height: 1080,
        sha256:
          "aabbcc1234567890aabbcc1234567890aabbcc1234567890aabbcc1234567890",
      },
    });

    const post = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Teste de falha parcial",
        status: "APPROVED",
      },
    });

    const res = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id, igAccount.id],
        mediaAssetId: media.id,
        idempotencyKey: "idem_partial_failure_789",
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.attempts).toHaveLength(2);

    const fbAttempt = body.attempts.find(
      (a: { platform: string }) => a.platform === "FACEBOOK_PAGE",
    );
    const igAttempt = body.attempts.find(
      (a: { platform: string }) => a.platform === "INSTAGRAM_BUSINESS",
    );

    expect(fbAttempt.status).toBe("PUBLISHED");
    expect(igAttempt.status).toBe("FAILED");
    expect(igAttempt.errorCode).toBe("190");

    // Verifica que a conta Instagram foi atualizada para EXPIRED no banco
    const updatedIgAcc = await migration.socialAccount.findUnique({
      where: { id: igAccount.id },
    });
    expect(updatedIgAcc?.status).toBe("EXPIRED");

    // Verifica que o erro foi registrado no AuditLog para a tentativa com falha
    const failedAudit = await migration.auditLog.findFirst({
      where: { entityId: igAttempt.id, action: "post.publish_failed" },
    });
    expect(failedAudit).not.toBeNull();
  });

  it("trata duas requisições simultâneas com a mesma chave de idempotência sem duplicar tentativas", async () => {
    const cookie = await login("admin-a");

    const fbAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: "fb_page_conc_1",
        name: "Página Concorrente",
        status: "ACTIVE",
      },
    });
    const fbEnc = cryptoHelper.encrypt("valid_token", {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: "fb_page_conc_1",
      keyVersion: 1,
    });
    await migration.oAuthCredential.create({
      data: {
        socialAccountId: fbAccount.id,
        encryptedAccessToken: fbEnc.encryptedAccessToken,
        iv: fbEnc.iv,
        authTag: fbEnc.authTag,
        keyVersion: 1,
      },
    });

    const post = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Teste de concorrência com mesma chave",
        status: "APPROVED",
      },
    });

    const idempotencyKey = "idem_concurrent_same_key_" + randomUUID();

    const [res1, res2] = await Promise.all([
      request(
        `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
        cookie,
        "POST",
        {
          socialAccountIds: [fbAccount.id],
          idempotencyKey,
        },
      ),
      request(
        `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
        cookie,
        "POST",
        {
          socialAccountIds: [fbAccount.id],
          idempotencyKey,
        },
      ),
    ]);

    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(200);
    expect(statuses.some((s) => s === 200 || s === 409)).toBe(true);

    const attempts = await migration.publicationAttempt.findMany({
      where: { postId: post.id, socialAccountId: fbAccount.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("PUBLISHED");
  });

  it("impede nova publicação (409) do mesmo post e conta mesmo com chave de idempotência diferente", async () => {
    const cookie = await login("admin-a");

    const fbAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: "fb_page_dup_2",
        name: "Página Anti-Duplicação",
        status: "ACTIVE",
      },
    });
    const fbEnc = cryptoHelper.encrypt("valid_token", {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: "fb_page_dup_2",
      keyVersion: 1,
    });
    await migration.oAuthCredential.create({
      data: {
        socialAccountId: fbAccount.id,
        encryptedAccessToken: fbEnc.encryptedAccessToken,
        iv: fbEnc.iv,
        authTag: fbEnc.authTag,
        keyVersion: 1,
      },
    });

    const post = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Teste anti-duplicação persistente no PostgreSQL",
        status: "APPROVED",
      },
    });

    // 1ª publicação com chave A
    const res1 = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        idempotencyKey: "idem_key_AAA_" + randomUUID(),
      },
    );
    expect(res1.status).toBe(200);

    // 2ª publicação com chave B (diferente) para a mesma conta e post
    const res2 = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        idempotencyKey: "idem_key_BBB_" + randomUUID(),
      },
    );
    expect(res2.status).toBe(409);
    const body2 = await res2.json();
    expect(body2.message).toContain("já publicado com sucesso");

    // Permanece com apenas 1 tentativa no banco
    const attempts = await migration.publicationAttempt.findMany({
      where: { postId: post.id, socialAccountId: fbAccount.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("PUBLISHED");
  });

  it("permite retomada controlada após falha, incrementando attemptNumber para 2 e concluindo", async () => {
    const cookie = await login("admin-a");

    const fbAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: "fb_page_resume_3",
        name: "Página Retomada",
        status: "ACTIVE",
      },
    });
    const fbEnc = cryptoHelper.encrypt("valid_token", {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: "fb_page_resume_3",
      keyVersion: 1,
    });
    await migration.oAuthCredential.create({
      data: {
        socialAccountId: fbAccount.id,
        encryptedAccessToken: fbEnc.encryptedAccessToken,
        iv: fbEnc.iv,
        authTag: fbEnc.authTag,
        keyVersion: 1,
      },
    });

    const post = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Post que falhou anteriormente",
        status: "APPROVED",
      },
    });

    // Insere tentativa prévia com falha (status = FAILED, attemptNumber = 1)
    await migration.publicationAttempt.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        postId: post.id,
        socialAccountId: fbAccount.id,
        status: "FAILED",
        attemptNumber: 1,
        errorCode: "PREVIOUS_NETWORK_ERROR",
        errorMessage: "Falha transitória simulada",
        executedAt: new Date(Date.now() - 60000),
      },
    });

    // Executa retomada explícita
    const res = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        idempotencyKey: "idem_resume_after_fail_" + randomUUID(),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.attempts[0].attemptNumber).toBe(2);
    expect(body.attempts[0].status).toBe("PUBLISHED");

    const allAttempts = await migration.publicationAttempt.findMany({
      where: { postId: post.id, socialAccountId: fbAccount.id },
      orderBy: { attemptNumber: "asc" },
    });
    expect(allAttempts).toHaveLength(2);
    expect(allAttempts[0]!.status).toBe("FAILED");
    expect(allAttempts[0]!.attemptNumber).toBe(1);
    expect(allAttempts[1]!.status).toBe("PUBLISHED");
    expect(allAttempts[1]!.attemptNumber).toBe(2);
  });

  it("no Instagram, se já existir creationContainerId de tentativa anterior, a retomada reaproveita o container", async () => {
    const cookie = await login("admin-a");

    const igAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "INSTAGRAM_BUSINESS",
        platformAccountId: "ig_page_resume_cont_4",
        name: "IG Retomada Container",
        status: "ACTIVE",
      },
    });
    const igEnc = cryptoHelper.encrypt("valid_token", {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: "ig_page_resume_cont_4",
      keyVersion: 1,
    });
    await migration.oAuthCredential.create({
      data: {
        socialAccountId: igAccount.id,
        encryptedAccessToken: igEnc.encryptedAccessToken,
        iv: igEnc.iv,
        authTag: igEnc.authTag,
        keyVersion: 1,
      },
    });

    const mediaId = randomUUID();
    const media = await migration.mediaAsset.create({
      data: {
        id: mediaId,
        organizationId: "org-a",
        clientId: "client-a",
        name: "Foto IG Container",
        storageKey: `media/org-a/client-a/${mediaId}`,
        status: "ready",
        mimeType: "image/jpeg",
        byteSize: 4096,
        width: 1080,
        height: 1080,
        sha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    });

    const post = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Post IG com container anterior",
        status: "APPROVED",
      },
    });

    // Insere tentativa anterior FAILED com creationContainerId registrado
    await migration.publicationAttempt.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        postId: post.id,
        socialAccountId: igAccount.id,
        status: "FAILED",
        attemptNumber: 1,
        creationContainerId: "ig_container_mock_resumed_777",
        errorCode: "PREV_ERROR",
        errorMessage: "Falha após criar container",
        executedAt: new Date(Date.now() - 30000),
      },
    });

    const res = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [igAccount.id],
        mediaAssetId: media.id,
        idempotencyKey: "idem_ig_resume_cont_" + randomUUID(),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.attempts[0].status).toBe("PUBLISHED");
    // Confirmou e continuou o container existente
    expect(body.attempts[0].creationContainerId).toBe(
      "ig_container_mock_resumed_777",
    );
    expect(body.attempts[0].attemptNumber).toBe(2);
  });

  it("registra estado UNCERTAIN e bloqueia nova publicação concorrente após timeout remoto na Meta", async () => {
    const cookie = await login("admin-a");

    const fbAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: "fb_page_timeout_5",
        name: "Página Timeout",
        status: "ACTIVE",
      },
    });
    // Token contendo "timeout" faz o mock retornar 504 Gateway Timeout
    const fbEnc = cryptoHelper.encrypt("timeout_token_simulated", {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: "fb_page_timeout_5",
      keyVersion: 1,
    });
    await migration.oAuthCredential.create({
      data: {
        socialAccountId: fbAccount.id,
        encryptedAccessToken: fbEnc.encryptedAccessToken,
        iv: fbEnc.iv,
        authTag: fbEnc.authTag,
        keyVersion: 1,
      },
    });

    const post = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Post que sofrerá timeout remoto",
        status: "APPROVED",
      },
    });

    const res = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        idempotencyKey: "idem_timeout_test_" + randomUUID(),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.attempts[0].status).toBe("UNCERTAIN");
    expect(body.attempts[0].errorCode).toBe("REMOTE_TIMEOUT");

    // Verifica que foi registrado no AuditLog como incerto
    const auditEntry = await migration.auditLog.findFirst({
      where: {
        entityId: body.attempts[0].id,
        action: "post.publish_uncertain",
      },
    });
    expect(auditEntry).not.toBeNull();

    // Uma nova tentativa com outra chave deve ser rejeitada com 409 devido ao estado UNCERTAIN
    const resRetry = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        idempotencyKey: "idem_timeout_retry_" + randomUUID(),
      },
    );
    expect(resRetry.status).toBe(409);
    const retryBody = await resRetry.json();
    expect(retryBody.message).toContain("aguardando reconciliação");
  });

  it("garante que chamadas externas à Meta ocorrem fora de transação longa (transação curta liberada antes da Meta)", async () => {
    const cookie = await login("admin-a");

    const fbAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: "fb_page_no_tx_6",
        name: "Página Sem Lock Longo",
        status: "ACTIVE",
      },
    });
    const fbEnc = cryptoHelper.encrypt("valid_token", {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: "fb_page_no_tx_6",
      keyVersion: 1,
    });
    await migration.oAuthCredential.create({
      data: {
        socialAccountId: fbAccount.id,
        encryptedAccessToken: fbEnc.encryptedAccessToken,
        iv: fbEnc.iv,
        authTag: fbEnc.authTag,
        keyVersion: 1,
      },
    });

    const post = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Post teste isolamento transacional",
        status: "APPROVED",
      },
    });

    let hookExecuted = false;
    onBeforePublishHook = async () => {
      hookExecuted = true;
      // Prova 1: A tentativa de publicação já foi commitada no banco no estado PROCESSING
      const attemptDuringPublish = await migration.publicationAttempt.findFirst(
        {
          where: { postId: post.id, socialAccountId: fbAccount.id },
        },
      );
      expect(attemptDuringPublish).not.toBeNull();
      expect(attemptDuringPublish?.status).toBe("PROCESSING");

      // Prova 2: Executar escrita e leitura concorrentes no banco sem nenhum bloqueio ou lock
      const clientRecord = await migration.client.findFirst({
        where: { id: "client-a" },
      });
      expect(clientRecord).not.toBeNull();

      const testRecord = await migration.rateLimit.create({
        data: {
          id: randomUUID(),
          key: "concurrent_write_during_meta_call_" + randomUUID(),
          count: 1,
          lastRequest: BigInt(Date.now()),
        },
      });
      expect(testRecord).not.toBeNull();
    };

    const res = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        idempotencyKey: "idem_no_long_tx_" + randomUUID(),
      },
    );

    expect(hookExecuted).toBe(true);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.attempts[0].status).toBe("PUBLISHED");
  });

  it("valida o endpoint de mídia pública: identificador opaco, múltiplos downloads no TTL e 404 para inválido/expirado", async () => {
    const testBytes = Buffer.from("imagem-binaria-de-teste-1234567890", "utf8");
    const sha256 = createHash("sha256").update(testBytes).digest("hex");
    const storageKey = `media/org-a/client-a/${randomUUID()}`;
    await mockStorage.put(storageKey, testBytes);

    // 1. Gera ticket opaco com TTL de 3600s
    const ticketId = await createPublicMediaTicket(redis, {
      organizationId: "org-a",
      clientId: "client-a",
      mediaId: randomUUID(),
      storageKey,
      mimeType: "image/jpeg",
      byteSize: testBytes.length,
      sha256,
    });

    // 2. Primeiro download pela Meta
    const res1 = await fetch(`${apiBase}/api/public/media/${ticketId}`);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toBe("image/jpeg");
    expect(res1.headers.get("cache-control")).toContain("max-age=3600");
    const body1 = Buffer.from(await res1.arrayBuffer());
    expect(body1).toEqual(testBytes);

    // 3. Segundo download da mesma mídia (comprova que o ticket NÃO é consumido/deletado no primeiro acesso)
    const res2 = await fetch(`${apiBase}/api/public/media/${ticketId}`);
    expect(res2.status).toBe(200);
    const body2 = Buffer.from(await res2.arrayBuffer());
    expect(body2).toEqual(testBytes);

    // 4. Ticket adulterado ou inválido retorna 404 sem vazar detalhes internos
    const resTampered = await fetch(
      `${apiBase}/api/public/media/invalid_tampered_ticket_12345`,
    );
    expect(resTampered.status).toBe(404);
    const errTampered = await resTampered.json();
    expect(errTampered.message).toBe("Mídia indisponível ou expirada.");

    // 5. Ticket com formato 64 hex válido mas expirado/inexistente no Redis retorna 404
    const nonExistentTicket = "f".repeat(64);
    const resExpired = await fetch(
      `${apiBase}/api/public/media/${nonExistentTicket}`,
    );
    expect(resExpired.status).toBe(404);
    const errExpired = await resExpired.json();
    expect(errExpired.message).toBe("Mídia indisponível ou expirada.");
  });
});
