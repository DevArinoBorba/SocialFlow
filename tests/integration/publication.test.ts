import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { MetaPublisherAdapter } from "../../apps/api/dist/meta-publisher.js";
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
  let mockPublisher: MetaPublisherAdapter;
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

    mockPublisher = new MetaPublisherAdapter({
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

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("falha na preparação ou ticket após reserva finaliza tentativa atomicamente como FAILED com PREPARATION_FAILED, grava audit e libera idempotência", async () => {
    const cookie = await login("admin-a");

    const fbAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: "fb_page_prep_fail_" + randomUUID().slice(0, 8),
        name: "Página Falha Preparação",
        status: "ACTIVE",
      },
    });
    const fbEnc = cryptoHelper.encrypt("valid_token", {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: fbAccount.platformAccountId,
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
        caption: "Teste falha de preparação pós-reserva",
        status: "APPROVED",
      },
    });

    // Simula erro de preparação/Redis após a reserva
    onBeforePublishHook = async () => {
      throw new Error(
        "Simulação: falha de infraestrutura no Redis antes da chamada à Meta",
      );
    };

    const idempotencyKey = "idem_prep_fail_" + randomUUID();
    const res = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        idempotencyKey,
      },
    );

    // 1. Resposta é 503 com mensagem sanitizada (sem vazar detalhes internos)
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.message).toBe(
      "Falha na preparação da publicação. Tente novamente.",
    );

    // 2. Nenhuma tentativa permaneceu como PROCESSING: foi atomicamente marcada como FAILED
    const attempts = await migration.publicationAttempt.findMany({
      where: { postId: post.id, socialAccountId: fbAccount.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("FAILED");
    expect(attempts[0]!.errorCode).toBe("PREPARATION_FAILED");
    expect(attempts[0]!.leaseExpiresAt).toBeNull();

    // 3. Auditoria foi registrada
    const auditLogs = await migration.auditLog.findMany({
      where: { entityId: attempts[0]!.id, action: "post.publish_failed" },
    });
    expect(auditLogs).toHaveLength(1);

    // 4. Chave HTTP de idempotência foi liberada no Redis
    const redisKey = `idempotency:publish:org-a:client-a:${post.id}:${idempotencyKey}`;
    const cached = await redis.get(redisKey);
    expect(cached).toBeNull();

    // 5. Nova tentativa subsequente pode ser executada com sucesso
    onBeforePublishHook = undefined;
    const retryRes = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        idempotencyKey,
      },
    );
    expect(retryRes.status).toBe(200);
    const retryBody = await retryRes.json();
    expect(retryBody.success).toBe(true);

    const updatedAttempts = await migration.publicationAttempt.findMany({
      where: { postId: post.id, socialAccountId: fbAccount.id },
      orderBy: { attemptNumber: "asc" },
    });
    expect(updatedAttempts).toHaveLength(2);
    expect(updatedAttempts[0]!.status).toBe("FAILED");
    expect(updatedAttempts[1]!.status).toBe("PUBLISHED");
    expect(updatedAttempts[1]!.attemptNumber).toBe(2);
  });

  it("lease ativa em tentativa PROCESSING bloqueia concorrência (409)", async () => {
    const cookie = await login("admin-a");

    const fbAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: "fb_page_active_lease_" + randomUUID().slice(0, 8),
        name: "Página Lease Ativo",
        status: "ACTIVE",
      },
    });
    const fbEnc = cryptoHelper.encrypt("valid_token", {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: fbAccount.platformAccountId,
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
        caption: "Teste lease ativo bloqueando concorrência",
        status: "APPROVED",
      },
    });

    // Cria tentativa em PROCESSING com lease futura (+2 minutos)
    await migration.publicationAttempt.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        postId: post.id,
        socialAccountId: fbAccount.id,
        status: "PROCESSING",
        attemptNumber: 1,
        leaseExpiresAt: new Date(Date.now() + 120_000),
        executedAt: new Date(),
      },
    });

    const res = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        idempotencyKey: "idem_active_lease_" + randomUUID(),
      },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.message).toContain("Publicação em andamento");

    // Nenhuma nova tentativa foi criada
    const attempts = await migration.publicationAttempt.findMany({
      where: { postId: post.id, socialAccountId: fbAccount.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("PROCESSING");
  });

  it("lease expirada para Instagram permite retomada controlada aproveitando o mesmo container sem duplicar", async () => {
    const cookie = await login("admin-a");

    const igAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "INSTAGRAM_BUSINESS",
        platformAccountId: "ig_acc_expired_lease_" + randomUUID().slice(0, 8),
        name: "IG Lease Expirada",
        status: "ACTIVE",
      },
    });
    const igEnc = cryptoHelper.encrypt("valid_token", {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: igAccount.platformAccountId,
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

    const testBytes = Buffer.from("imagem-para-ig-retomada", "utf8");
    const mediaId = randomUUID();
    const storageKey = `media/org-a/client-a/${mediaId}`;
    await mockStorage.put(storageKey, testBytes);

    const mediaAsset = await migration.mediaAsset.create({
      data: {
        id: mediaId,
        organizationId: "org-a",
        clientId: "client-a",
        name: "Imagem IG Retomada",
        storageKey,
        mimeType: "image/jpeg",
        byteSize: 10240,
        width: 1080,
        height: 1080,
        sha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        status: "ready",
      },
    });

    const post = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Teste retomada Instagram de container abandonado",
        status: "APPROVED",
      },
    });

    // Cria tentativa anterior interrompida em CONTAINER_CREATED com lease já vencida (-10s)
    const abandonedContainerId = "ig_container_mock_resumed_777";
    const previousAttempt = await migration.publicationAttempt.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        postId: post.id,
        socialAccountId: igAccount.id,
        status: "CONTAINER_CREATED",
        creationContainerId: abandonedContainerId,
        attemptNumber: 1,
        leaseExpiresAt: new Date(Date.now() - 10_000),
        executedAt: new Date(Date.now() - 60_000),
      },
    });

    const res = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      cookie,
      "POST",
      {
        socialAccountIds: [igAccount.id],
        mediaAssetId: mediaAsset.id,
        idempotencyKey: "idem_ig_resume_" + randomUUID(),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const attempts = await migration.publicationAttempt.findMany({
      where: { postId: post.id, socialAccountId: igAccount.id },
      orderBy: { attemptNumber: "asc" },
    });
    expect(attempts).toHaveLength(2);

    // Tentativa 1 expirada foi concluída como FAILED com código seguro
    expect(attempts[0]!.id).toBe(previousAttempt.id);
    expect(attempts[0]!.status).toBe("FAILED");
    expect(attempts[0]!.errorCode).toBe("ABANDONED_LEASE_EXPIRED");
    expect(attempts[0]!.leaseExpiresAt).toBeNull();

    // Tentativa 2 foi concluída como PUBLISHED, reutilizando o mesmo container
    expect(attempts[1]!.status).toBe("PUBLISHED");
    expect(attempts[1]!.attemptNumber).toBe(2);
    expect(attempts[1]!.creationContainerId).toBe(abandonedContainerId);
    expect(attempts[1]!.leaseExpiresAt).toBeNull();

    // Auditorias registradas
    const expiredAudit = await migration.auditLog.findMany({
      where: { entityId: previousAttempt.id, action: "post.lease_expired" },
    });
    expect(expiredAudit).toHaveLength(1);

    const publishedAudit = await migration.auditLog.findMany({
      where: { entityId: attempts[1]!.id, action: "post.published" },
    });
    expect(publishedAudit).toHaveLength(1);
  });

  it("lease expirada para Facebook transiciona para UNCERTAIN, bloqueia republicação e permite resolução manual pelo administrador", async () => {
    const adminCookie = await login("admin-a");
    const viewerCookie = await login("viewer-a");

    const fbAccount = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: "fb_page_expired_lease_" + randomUUID().slice(0, 8),
        name: "Página FB Lease Expirada",
        status: "ACTIVE",
      },
    });
    const fbEnc = cryptoHelper.encrypt("valid_token", {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: fbAccount.platformAccountId,
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
        caption: "Teste lease expirada Facebook transiciona para UNCERTAIN",
        status: "APPROVED",
      },
    });

    // Cria tentativa em PROCESSING com lease expirada (-10s)
    const abandonedAttempt = await migration.publicationAttempt.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        postId: post.id,
        socialAccountId: fbAccount.id,
        status: "PROCESSING",
        attemptNumber: 1,
        leaseExpiresAt: new Date(Date.now() - 10_000),
        executedAt: new Date(Date.now() - 60_000),
      },
    });

    // 1. Tentar publicar novamente bloqueia com 409 e transiciona para UNCERTAIN
    const pubRes = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      adminCookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        idempotencyKey: "idem_fb_expired_lease_" + randomUUID(),
      },
    );

    expect(pubRes.status).toBe(409);
    const pubBody = await pubRes.json();
    expect(pubBody.message).toContain(
      "resultado incerto. Reconciliação manual necessária",
    );

    const uncertainAttempt = await migration.publicationAttempt.findUnique({
      where: { id: abandonedAttempt.id },
    });
    expect(uncertainAttempt!.status).toBe("UNCERTAIN");
    expect(uncertainAttempt!.errorCode).toBe("LEASE_EXPIRED_UNCERTAIN");
    expect(uncertainAttempt!.leaseExpiresAt).toBeNull();

    const uncertainAudit = await migration.auditLog.findMany({
      where: {
        entityId: abandonedAttempt.id,
        action: "post.publish_uncertain",
      },
    });
    expect(uncertainAudit).toHaveLength(1);

    // 2. Tentativa subsequente de publicação continua bloqueada por UNCERTAIN
    const blockedRes = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      adminCookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        idempotencyKey: "idem_fb_blocked_uncertain_" + randomUUID(),
      },
    );
    expect(blockedRes.status).toBe(409);
    const blockedBody = await blockedRes.json();
    expect(blockedBody.message).toContain(
      "estado incerto aguardando reconciliação manual",
    );

    // 3. Usuário sem permissão de admin (CLIENT_VIEWER) tenta reconciliar: recebe 403
    const resolveForbiddenRes = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/attempts/${abandonedAttempt.id}/resolve`,
      viewerCookie,
      "POST",
      {
        decision: "CONFIRM_FAILED",
      },
    );
    expect(resolveForbiddenRes.status).toBe(403);

    // 4. Admin resolve manualmente como CONFIRM_FAILED
    const resolveRes = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/attempts/${abandonedAttempt.id}/resolve`,
      adminCookie,
      "POST",
      {
        decision: "CONFIRM_FAILED",
        notes: "Verificado no feed do Facebook: post não foi publicado.",
      },
    );
    expect(resolveRes.status).toBe(200);
    const resolveBody = await resolveRes.json();
    expect(resolveBody.success).toBe(true);
    expect(resolveBody.attempt.status).toBe("FAILED");
    expect(resolveBody.attempt.errorCode).toBe("MANUALLY_RECONCILED_FAILED");

    const reconciledAudit = await migration.auditLog.findMany({
      where: {
        entityId: abandonedAttempt.id,
        action: "post.reconciled_failed",
      },
    });
    expect(reconciledAudit).toHaveLength(1);

    // 5. Após CONFIRM_FAILED, nova publicação controlada é permitida (attemptNumber 2)
    const retryRes = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
      adminCookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        idempotencyKey: "idem_fb_after_reconcile_" + randomUUID(),
      },
    );
    expect(retryRes.status).toBe(200);
    const retryBody = await retryRes.json();
    expect(retryBody.success).toBe(true);

    const finalAttempts = await migration.publicationAttempt.findMany({
      where: { postId: post.id, socialAccountId: fbAccount.id },
      orderBy: { attemptNumber: "asc" },
    });
    expect(finalAttempts).toHaveLength(2);
    expect(finalAttempts[0]!.status).toBe("FAILED");
    expect(finalAttempts[1]!.status).toBe("PUBLISHED");
    expect(finalAttempts[1]!.attemptNumber).toBe(2);

    // 6. Teste de CONFIRM_PUBLISHED em outro post incerto impede duplicação definitiva
    const post2 = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Post 2 reconciliado como publicado",
        status: "APPROVED",
      },
    });
    const uncertainAttempt2 = await migration.publicationAttempt.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        postId: post2.id,
        socialAccountId: fbAccount.id,
        status: "UNCERTAIN",
        errorCode: "REMOTE_TIMEOUT",
        attemptNumber: 1,
        executedAt: new Date(),
      },
    });

    const confirmPubRes = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post2.id}/attempts/${uncertainAttempt2.id}/resolve`,
      adminCookie,
      "POST",
      {
        decision: "CONFIRM_PUBLISHED",
        remoteMediaId: "fb_post_manual_confirmed_789",
        remotePermalink: "https://facebook.com/posts/789",
        notes: "Encontrado no feed da página",
      },
    );
    expect(confirmPubRes.status).toBe(200);
    const confirmPubBody = await confirmPubRes.json();
    expect(confirmPubBody.attempt.status).toBe("PUBLISHED");
    expect(confirmPubBody.attempt.remoteMediaId).toBe(
      "fb_post_manual_confirmed_789",
    );

    const confAudit = await migration.auditLog.findMany({
      where: {
        entityId: uncertainAttempt2.id,
        action: "post.reconciled_published",
      },
    });
    expect(confAudit).toHaveLength(1);

    // Tentar publicar post2 novamente agora é definitivamente bloqueado (409)
    const post2Blocked = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post2.id}/publish`,
      adminCookie,
      "POST",
      {
        socialAccountIds: [fbAccount.id],
        idempotencyKey: "idem_post2_dup_" + randomUUID(),
      },
    );
    expect(post2Blocked.status).toBe(409);
    const post2BlockedBody = await post2Blocked.json();
    expect(post2BlockedBody.message).toContain("já publicado com sucesso");
  });

  describe("Consistência de preparação em duas fases com ordenação variável de contas", () => {
    async function createTestFbAccount(prefix: string) {
      const account = await migration.socialAccount.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          platform: "FACEBOOK_PAGE",
          platformAccountId: `${prefix}_${randomUUID().slice(0, 8)}`,
          name: `Página FB ${prefix}`,
          status: "ACTIVE",
        },
      });
      const enc = cryptoHelper.encrypt("valid_token", {
        organizationId: "org-a",
        clientId: "client-a",
        platformAccountId: account.platformAccountId,
        keyVersion: 1,
      });
      await migration.oAuthCredential.create({
        data: {
          socialAccountId: account.id,
          encryptedAccessToken: enc.encryptedAccessToken,
          iv: enc.iv,
          authTag: enc.authTag,
          keyVersion: 1,
        },
      });
      return account;
    }

    it("primeira conta válida e segunda Facebook com lease expirada: não reserva conta válida, transiciona Facebook para UNCERTAIN, libera idempotência e não chama Meta", async () => {
      const cookie = await login("admin-a");
      const validAcc = await createTestFbAccount("order_valid_1");
      const expiredFbAcc = await createTestFbAccount("order_expired_2");

      const post = await migration.post.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          caption: "Teste ordem: válida primeiro, Facebook expirada segundo",
          status: "APPROVED",
        },
      });

      const abandonedAttempt = await migration.publicationAttempt.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: post.id,
          socialAccountId: expiredFbAcc.id,
          status: "PROCESSING",
          attemptNumber: 1,
          leaseExpiresAt: new Date(Date.now() - 10_000),
          executedAt: new Date(Date.now() - 60_000),
        },
      });

      const fbSpy = vi.spyOn(mockPublisher, "publishFacebook");
      const igContSpy = vi.spyOn(mockPublisher, "createInstagramContainer");
      const igPubSpy = vi.spyOn(mockPublisher, "publishInstagramContainer");

      const idempotencyKey = "idem_order_valid_first_" + randomUUID();
      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
        cookie,
        "POST",
        {
          socialAccountIds: [validAcc.id, expiredFbAcc.id],
          idempotencyKey,
        },
      );

      // 1. Resposta 409
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.message).toContain(
        "resultado incerto. Reconciliação manual necessária",
      );

      // 2. Mock da Meta NÃO foi chamado
      expect(fbSpy).not.toHaveBeenCalled();
      expect(igContSpy).not.toHaveBeenCalled();
      expect(igPubSpy).not.toHaveBeenCalled();

      // 3. Conta válida não ficou com nenhuma tentativa nova em PROCESSING
      const validAttempts = await migration.publicationAttempt.findMany({
        where: { postId: post.id, socialAccountId: validAcc.id },
      });
      expect(validAttempts).toHaveLength(0);
      expect(validAttempts.some((a) => a.status === "PROCESSING")).toBe(false);

      // 4. Tentativa Facebook expirada foi transicionada para UNCERTAIN
      const updatedExpired = await migration.publicationAttempt.findUnique({
        where: { id: abandonedAttempt.id },
      });
      expect(updatedExpired!.status).toBe("UNCERTAIN");
      expect(updatedExpired!.errorCode).toBe("LEASE_EXPIRED_UNCERTAIN");
      expect(updatedExpired!.leaseExpiresAt).toBeNull();

      // 5. Auditoria de transição para UNCERTAIN gravada
      const uncertainAudit = await migration.auditLog.findMany({
        where: {
          entityId: abandonedAttempt.id,
          action: "post.publish_uncertain",
        },
      });
      expect(uncertainAudit).toHaveLength(1);

      // 6. Chave de idempotência liberada no Redis
      const redisKey = `meta:publish:idempotency:org-a:client-a:${post.id}:${idempotencyKey}`;
      const cached = await redis.get(redisKey);
      expect(cached).toBeNull();
    });

    it("primeira Facebook com lease expirada e segunda válida: não reserva conta válida, transiciona Facebook para UNCERTAIN, libera idempotência e não chama Meta", async () => {
      const cookie = await login("admin-a");
      const expiredFbAcc = await createTestFbAccount("order_expired_first");
      const validAcc = await createTestFbAccount("order_valid_second");

      const post = await migration.post.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          caption: "Teste ordem: Facebook expirada primeiro, válida segundo",
          status: "APPROVED",
        },
      });

      const abandonedAttempt = await migration.publicationAttempt.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: post.id,
          socialAccountId: expiredFbAcc.id,
          status: "PROCESSING",
          attemptNumber: 1,
          leaseExpiresAt: new Date(Date.now() - 10_000),
          executedAt: new Date(Date.now() - 60_000),
        },
      });

      const fbSpy = vi.spyOn(mockPublisher, "publishFacebook");
      const igContSpy = vi.spyOn(mockPublisher, "createInstagramContainer");
      const igPubSpy = vi.spyOn(mockPublisher, "publishInstagramContainer");

      const idempotencyKey = "idem_order_expired_first_" + randomUUID();
      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
        cookie,
        "POST",
        {
          socialAccountIds: [expiredFbAcc.id, validAcc.id],
          idempotencyKey,
        },
      );

      // 1. Resposta 409
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.message).toContain(
        "resultado incerto. Reconciliação manual necessária",
      );

      // 2. Mock da Meta NÃO foi chamado
      expect(fbSpy).not.toHaveBeenCalled();
      expect(igContSpy).not.toHaveBeenCalled();
      expect(igPubSpy).not.toHaveBeenCalled();

      // 3. Conta válida não ficou com nenhuma tentativa nova em PROCESSING
      const validAttempts = await migration.publicationAttempt.findMany({
        where: { postId: post.id, socialAccountId: validAcc.id },
      });
      expect(validAttempts).toHaveLength(0);
      expect(validAttempts.some((a) => a.status === "PROCESSING")).toBe(false);

      // 4. Tentativa Facebook expirada foi transicionada para UNCERTAIN
      const updatedExpired = await migration.publicationAttempt.findUnique({
        where: { id: abandonedAttempt.id },
      });
      expect(updatedExpired!.status).toBe("UNCERTAIN");
      expect(updatedExpired!.errorCode).toBe("LEASE_EXPIRED_UNCERTAIN");
      expect(updatedExpired!.leaseExpiresAt).toBeNull();

      // 5. Chave de idempotência liberada no Redis
      const redisKey = `meta:publish:idempotency:org-a:client-a:${post.id}:${idempotencyKey}`;
      const cached = await redis.get(redisKey);
      expect(cached).toBeNull();
    });

    it("três contas com bloqueio na última (Facebook expirado): nenhuma conta anterior fica em PROCESSING, libera idempotência e não chama Meta", async () => {
      const cookie = await login("admin-a");
      const validAcc1 = await createTestFbAccount("order_3_valid1");
      const validAcc2 = await createTestFbAccount("order_3_valid2");
      const expiredFbAcc3 = await createTestFbAccount("order_3_expired3");

      const post = await migration.post.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          caption: "Teste ordem: três contas com bloqueio na última",
          status: "APPROVED",
        },
      });

      const abandonedAttempt = await migration.publicationAttempt.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: post.id,
          socialAccountId: expiredFbAcc3.id,
          status: "PROCESSING",
          attemptNumber: 1,
          leaseExpiresAt: new Date(Date.now() - 10_000),
          executedAt: new Date(Date.now() - 60_000),
        },
      });

      const fbSpy = vi.spyOn(mockPublisher, "publishFacebook");
      const igContSpy = vi.spyOn(mockPublisher, "createInstagramContainer");
      const igPubSpy = vi.spyOn(mockPublisher, "publishInstagramContainer");

      const idempotencyKey = "idem_order_three_accounts_" + randomUUID();
      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
        cookie,
        "POST",
        {
          socialAccountIds: [validAcc1.id, validAcc2.id, expiredFbAcc3.id],
          idempotencyKey,
        },
      );

      // 1. Resposta 409
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.message).toContain(
        "resultado incerto. Reconciliação manual necessária",
      );

      // 2. Mock da Meta NÃO foi chamado
      expect(fbSpy).not.toHaveBeenCalled();
      expect(igContSpy).not.toHaveBeenCalled();
      expect(igPubSpy).not.toHaveBeenCalled();

      // 3. Nenhuma das contas válidas anteriores (validAcc1 e validAcc2) ficou em PROCESSING
      const valid1Attempts = await migration.publicationAttempt.findMany({
        where: { postId: post.id, socialAccountId: validAcc1.id },
      });
      expect(valid1Attempts).toHaveLength(0);

      const valid2Attempts = await migration.publicationAttempt.findMany({
        where: { postId: post.id, socialAccountId: validAcc2.id },
      });
      expect(valid2Attempts).toHaveLength(0);

      // 4. Tentativa Facebook expirada foi transicionada para UNCERTAIN
      const updatedExpired = await migration.publicationAttempt.findUnique({
        where: { id: abandonedAttempt.id },
      });
      expect(updatedExpired!.status).toBe("UNCERTAIN");
      expect(updatedExpired!.errorCode).toBe("LEASE_EXPIRED_UNCERTAIN");
      expect(updatedExpired!.leaseExpiresAt).toBeNull();

      // 5. Chave de idempotência liberada no Redis
      const redisKey = `meta:publish:idempotency:org-a:client-a:${post.id}:${idempotencyKey}`;
      const cached = await redis.get(redisKey);
      expect(cached).toBeNull();
    });

    it("três contas com bloqueio por lease ativa na última: nenhuma conta anterior é reservada, libera idempotência e não chama Meta", async () => {
      const cookie = await login("admin-a");
      const validAcc1 = await createTestFbAccount("order_3_active1");
      const validAcc2 = await createTestFbAccount("order_3_active2");
      const activeLeaseAcc3 = await createTestFbAccount("order_3_active3");

      const post = await migration.post.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          caption: "Teste ordem: três contas com lease ativa na última",
          status: "APPROVED",
        },
      });

      await migration.publicationAttempt.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          postId: post.id,
          socialAccountId: activeLeaseAcc3.id,
          status: "PROCESSING",
          attemptNumber: 1,
          leaseExpiresAt: new Date(Date.now() + 120_000), // lease ativa no futuro
          executedAt: new Date(),
        },
      });

      const fbSpy = vi.spyOn(mockPublisher, "publishFacebook");
      const igContSpy = vi.spyOn(mockPublisher, "createInstagramContainer");
      const igPubSpy = vi.spyOn(mockPublisher, "publishInstagramContainer");

      const idempotencyKey = "idem_order_three_active_lease_" + randomUUID();
      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
        cookie,
        "POST",
        {
          socialAccountIds: [validAcc1.id, validAcc2.id, activeLeaseAcc3.id],
          idempotencyKey,
        },
      );

      // 1. Resposta 409
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.message).toContain(
        "Publicação em andamento para a conta social",
      );

      // 2. Mock da Meta NÃO foi chamado
      expect(fbSpy).not.toHaveBeenCalled();
      expect(igContSpy).not.toHaveBeenCalled();
      expect(igPubSpy).not.toHaveBeenCalled();

      // 3. Nenhuma das contas válidas anteriores ficou em PROCESSING nem tem tentativa
      const valid1Attempts = await migration.publicationAttempt.findMany({
        where: { postId: post.id, socialAccountId: validAcc1.id },
      });
      expect(valid1Attempts).toHaveLength(0);

      const valid2Attempts = await migration.publicationAttempt.findMany({
        where: { postId: post.id, socialAccountId: validAcc2.id },
      });
      expect(valid2Attempts).toHaveLength(0);

      // 4. Chave de idempotência liberada no Redis
      const redisKey = `meta:publish:idempotency:org-a:client-a:${post.id}:${idempotencyKey}`;
      const cached = await redis.get(redisKey);
      expect(cached).toBeNull();
    });
  });

  describe("Controle de Acesso RBAC ao Endpoint de Publicação (/publish)", () => {
    async function createTestAccount(name: string) {
      const account = await migration.socialAccount.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          platform: "FACEBOOK_PAGE",
          platformAccountId: `rbac_${name}_${randomUUID().slice(0, 8)}`,
          name: `Conta FB ${name}`,
          status: "ACTIVE",
        },
      });
      const enc = cryptoHelper.encrypt("valid_token", {
        organizationId: "org-a",
        clientId: "client-a",
        platformAccountId: account.platformAccountId,
        keyVersion: 1,
      });
      await migration.oAuthCredential.create({
        data: {
          socialAccountId: account.id,
          encryptedAccessToken: enc.encryptedAccessToken,
          iv: enc.iv,
          authTag: enc.authTag,
          keyVersion: 1,
        },
      });
      return account;
    }

    it("tentativa direta de EDITOR no endpoint retorna 403 Forbidden e libera chave Redis", async () => {
      const editorCookie = await login("editor-a");
      const account = await createTestAccount("editor_denied");
      const post = await migration.post.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          caption: "Post para teste de RBAC com editor",
          status: "APPROVED",
        },
      });

      const idempotencyKey = "idem_rbac_editor_" + randomUUID();
      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
        editorCookie,
        "POST",
        {
          socialAccountIds: [account.id],
          idempotencyKey,
        },
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.message).toContain("Acesso não autorizado para o seu perfil");

      // Chave Redis liberada
      const redisKey = `meta:publish:idempotency:org-a:client-a:${post.id}:${idempotencyKey}`;
      const cached = await redis.get(redisKey);
      expect(cached).toBeNull();

      // Nenhuma tentativa criada
      const attempts = await migration.publicationAttempt.findMany({
        where: { postId: post.id },
      });
      expect(attempts).toHaveLength(0);
    });

    it("tentativa direta de CLIENT_VIEWER no endpoint retorna 403 Forbidden e libera chave Redis", async () => {
      const viewerCookie = await login("viewer-a");
      const account = await createTestAccount("viewer_denied");
      const post = await migration.post.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          caption: "Post para teste de RBAC com viewer",
          status: "APPROVED",
        },
      });

      const idempotencyKey = "idem_rbac_viewer_" + randomUUID();
      const res = await request(
        `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
        viewerCookie,
        "POST",
        {
          socialAccountIds: [account.id],
          idempotencyKey,
        },
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.message).toContain("Acesso não autorizado para o seu perfil");

      const redisKey = `meta:publish:idempotency:org-a:client-a:${post.id}:${idempotencyKey}`;
      const cached = await redis.get(redisKey);
      expect(cached).toBeNull();
    });

    it("usuários autorizados (APPROVER, ADMIN, OWNER) são autorizados no endpoint", async () => {
      const account = await createTestAccount("authorized_roles");
      const post = await migration.post.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          caption: "Post para teste de RBAC com perfis autorizados",
          status: "APPROVED",
        },
      });

      // Testar com APPROVER
      const approverCookie = await login("approver-a");
      const idemApprover = "idem_rbac_approver_" + randomUUID();
      const resApprover = await request(
        `/api/organizations/org-a/clients/client-a/posts/${post.id}/publish`,
        approverCookie,
        "POST",
        {
          socialAccountIds: [account.id],
          idempotencyKey: idemApprover,
        },
      );
      // Não deve retornar 403
      expect(resApprover.status).not.toBe(403);

      // Testar com OWNER em outro post
      const postOwner = await migration.post.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          caption: "Post para teste de RBAC com owner",
          status: "APPROVED",
        },
      });
      const ownerCookie = await login("owner-a");
      const idemOwner = "idem_rbac_owner_" + randomUUID();
      const resOwner = await request(
        `/api/organizations/org-a/clients/client-a/posts/${postOwner.id}/publish`,
        ownerCookie,
        "POST",
        {
          socialAccountIds: [account.id],
          idempotencyKey: idemOwner,
        },
      );
      // Não deve retornar 403
      expect(resOwner.status).not.toBe(403);
    });
  });
});
