import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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
});
