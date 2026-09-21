import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import {
  createDatabase,
  asActor,
  assertRuntimeRole,
  createCredentialCrypto,
  CryptoError,
  type Prisma,
} from "../../packages/db/src/index.js";
import { readConfig } from "../../packages/config/src/index.js";
import { createApplication } from "../../apps/api/dist/app.js";
import {
  startMetaMockServer,
  type MetaMockServer,
} from "../helpers/meta-mock.js";

const db = createDatabase(process.env.DATABASE_URL!);
const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);
const TEST_KEY_32 = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

beforeAll(async () => {
  await db.$connect();
  await migration.$connect();
});

afterAll(async () => {
  await db.$disconnect();
  await migration.$disconnect();
});

describe("Subincremento 3.1: PostgreSQL RLS, triggers e segurança criptográfica de SocialAccount", () => {
  it("valida RLS e FORCE RLS ativos nas tabelas SocialAccount, OAuthCredential e PublicationAttempt", async () => {
    await assertRuntimeRole(db);

    const tables = ["SocialAccount", "OAuthCredential", "PublicationAttempt"];
    for (const table of tables) {
      const result = await migration.$queryRaw<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ${table}`;

      expect(result[0]).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });

      const owner = await db.$queryRaw<
        { tableowner: string }[]
      >`SELECT tableowner FROM pg_tables WHERE tablename = ${table}`;
      expect(owner[0]?.tableowner).not.toBe("socialflow_runtime");
    }
  });

  it("garante isolamento multi-tenant: org-a não lê nem adultera SocialAccount de org-b", async () => {
    const accountB = await migration.socialAccount.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        platform: "FACEBOOK_PAGE",
        platformAccountId: `fb_page_${randomUUID()}`,
        name: "Page Tenant B",
      },
    });

    try {
      await asActor(db, "admin-a", async (tx) => {
        // org-a não visualiza conta de org-b
        const found = await tx.socialAccount.findMany({
          where: { organizationId: "org-b" },
        });
        expect(found).toEqual([]);

        // org-a não consegue atualizar conta de org-b
        const updated = await tx.socialAccount.updateMany({
          where: { id: accountB.id },
          data: { name: "Adulterado por A" },
        });
        expect(updated.count).toBe(0);
      });

      // org-a não consegue criar conta em escopo de org-b
      await expect(
        asActor(db, "admin-a", (tx) =>
          tx.socialAccount.create({
            data: {
              organizationId: "org-b",
              clientId: "client-b",
              platform: "INSTAGRAM_BUSINESS",
              platformAccountId: `ig_${randomUUID()}`,
              name: "Invasão Org B",
            },
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await migration.socialAccount.delete({ where: { id: accountB.id } });
    }
  });

  it("garante que apenas perfis com can_edit_client conseguem ler/gravar OAuthCredential", async () => {
    const accountA = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: `fb_page_${randomUUID()}`,
        name: "Page Tenant A",
      },
    });

    const crypto = createCredentialCrypto(TEST_KEY_32, 1);
    const tokenPayload = crypto.encrypt("EAABwzSecretAccessToken123", {
      organizationId: "org-a",
      clientId: "client-a",
      platformAccountId: accountA.platformAccountId,
      keyVersion: 1,
    });

    try {
      // 1. ADMIN consegue criar credencial vinculada à conta
      await asActor(db, "admin-a", async (tx) => {
        await tx.oAuthCredential.create({
          data: {
            socialAccountId: accountA.id,
            encryptedAccessToken: tokenPayload.encryptedAccessToken,
            iv: tokenPayload.iv,
            authTag: tokenPayload.authTag,
            keyVersion: 1,
            tokenType: "PAGE_ACCESS_TOKEN",
            scopes: ["pages_show_list", "pages_read_engagement"],
          },
        });
      });

      // 2. ADMIN consegue ler e decriptar a credencial
      await asActor(db, "admin-a", async (tx) => {
        const cred = await tx.oAuthCredential.findUnique({
          where: { socialAccountId: accountA.id },
        });
        expect(cred).not.toBeNull();
        expect(cred?.encryptedAccessToken).toBe(
          tokenPayload.encryptedAccessToken,
        );

        const decrypted = crypto.decrypt(
          {
            encryptedAccessToken: cred!.encryptedAccessToken,
            iv: cred!.iv,
            authTag: cred!.authTag,
            keyVersion: cred!.keyVersion,
          },
          {
            organizationId: "org-a",
            clientId: "client-a",
            platformAccountId: accountA.platformAccountId,
            keyVersion: cred!.keyVersion,
          },
        );
        expect(decrypted).toBe("EAABwzSecretAccessToken123");

        // AAD binding: tentar decriptar com tenant incorreto falha com CryptoError
        expect(() =>
          crypto.decrypt(
            {
              encryptedAccessToken: cred!.encryptedAccessToken,
              iv: cred!.iv,
              authTag: cred!.authTag,
              keyVersion: cred!.keyVersion,
            },
            {
              organizationId: "org-b",
              clientId: "client-a",
              platformAccountId: accountA.platformAccountId,
              keyVersion: cred!.keyVersion,
            },
          ),
        ).toThrow(CryptoError);
      });

      // 3. CLIENT_VIEWER (somente leitura de cliente) é bloqueado pelo RLS ao tentar ler OAuthCredential
      await asActor(db, "viewer-a", async (tx) => {
        const cred = await tx.oAuthCredential.findUnique({
          where: { socialAccountId: accountA.id },
        });
        expect(cred).toBeNull();
      });

      // 4. Invasor de outro tenant (admin-b) não enxerga nem acessa a credencial
      await asActor(db, "admin-b", async (tx) => {
        const cred = await tx.oAuthCredential.findUnique({
          where: { socialAccountId: accountA.id },
        });
        expect(cred).toBeNull();
      });
    } finally {
      await migration.socialAccount.delete({ where: { id: accountA.id } });
    }
  });

  it("trigger protect_social_account_scope impede mutação de organizationId, clientId ou platform", async () => {
    const account = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: `fb_${randomUUID()}`,
        name: "Page Scope Test",
      },
    });

    try {
      // Tentativa de alterar clientId é rejeitada pelo trigger com 42501
      await expect(
        migration.$executeRaw`
          UPDATE "SocialAccount"
          SET "clientId" = 'client-b'
          WHERE id = ${account.id}
        `,
      ).rejects.toThrow();

      // Tentativa de alterar platformAccountId é rejeitada pelo trigger com 42501
      await expect(
        migration.$executeRaw`
          UPDATE "SocialAccount"
          SET "platformAccountId" = 'tampered_id'
          WHERE id = ${account.id}
        `,
      ).rejects.toThrow();

      // Alteração de campos permitidos (nome, status) é aceita
      await asActor(db, "admin-a", async (tx) => {
        const updated = await tx.socialAccount.update({
          where: { id: account.id },
          data: { name: "Page Name Updated" },
        });
        expect(updated.name).toBe("Page Name Updated");
      });
    } finally {
      await migration.socialAccount.delete({ where: { id: account.id } });
    }
  });

  it("trigger protect_publication_attempt_scope protege integridade de tentativa de publicação", async () => {
    const account = await migration.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: `fb_${randomUUID()}`,
        name: "Page Pub Attempt Test",
      },
    });

    const post = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Post para teste de publicação",
        status: "APPROVED",
      },
    });

    const attempt = await migration.publicationAttempt.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        postId: post.id,
        socialAccountId: account.id,
        status: "PENDING",
      },
    });

    try {
      // Tentativa de trocar o post vinculado é barrada pelo trigger
      await expect(
        migration.$executeRaw`
          UPDATE "PublicationAttempt"
          SET "postId" = 'other-post-id'
          WHERE id = ${attempt.id}
        `,
      ).rejects.toThrow();

      // Atualização de status e IDs remotos de publicação ocorre normalmente
      await asActor(db, "admin-a", async (tx) => {
        const updated = await tx.publicationAttempt.update({
          where: { id: attempt.id },
          data: {
            status: "CONTAINER_CREATED",
            creationContainerId: "container_12345",
          },
        });
        expect(updated.status).toBe("CONTAINER_CREATED");
        expect(updated.creationContainerId).toBe("container_12345");
      });
    } finally {
      await migration.publicationAttempt.delete({ where: { id: attempt.id } });
      await migration.post.delete({ where: { id: post.id } });
      await migration.socialAccount.delete({ where: { id: account.id } });
    }
  });
});

describe("Subincremento 3.2: Meta OAuth, PKCE, Contas Sociais e Desconexão Segura", () => {
  let appRuntime: Awaited<ReturnType<typeof createApplication>>;
  let metaMock: MetaMockServer;
  let apiPort: number;
  let apiBase: string;
  let redis: Redis;

  const origin = process.env.APP_URL!;
  const password = process.env.DEV_SEED_PASSWORD!;

  async function request(
    path: string,
    cookie = "",
    method = "GET",
    data?: unknown,
    contentType = "application/json",
    requestOrigin = origin,
    extraHeaders?: Record<string, string>,
    redirectMode: RequestRedirect = "follow",
  ) {
    let body: BodyInit | undefined;
    if (data !== undefined) {
      if (Buffer.isBuffer(data)) {
        body = new Uint8Array(data);
      } else if (typeof data === "string") {
        body = data;
      } else {
        body = JSON.stringify(data);
      }
    }

    return fetch(`${apiBase}${path}`, {
      method,
      headers: {
        cookie,
        origin: requestOrigin,
        ...(contentType ? { "content-type": contentType } : {}),
        ...extraHeaders,
      },
      body,
      redirect: redirectMode,
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

    appRuntime = await createApplication(config, {
      socialAccountDependencies: {
        graphBaseUrl: metaMock.url,
        appId: "meta-test-app-id",
        appSecret: "meta-test-app-secret",
        masterKey: TEST_KEY_32,
      },
    });

    await appRuntime.app.listen(0, "127.0.0.1");
    const serverAddr = appRuntime.app.getHttpServer().address() as AddressInfo;
    apiPort = serverAddr.port;
    apiBase = `http://127.0.0.1:${apiPort}`;
  });

  afterAll(async () => {
    // Cleanup any remaining social accounts created during tests
    await migration.oAuthDiscoveryConsumption.deleteMany({});
    await migration.oAuthCredential.deleteMany({});
    await migration.publicationAttempt.deleteMany({});
    await migration.socialAccount.deleteMany({});

    redis.disconnect();
    await appRuntime.close();
    await metaMock.close();
  });

  beforeEach(async () => {
    await migration.rateLimit.deleteMany();
  });

  it("authorize gera PKCE, state criptográfico em Redis com TTL e URL da Meta válida", async () => {
    const cookie = await login("admin-a");
    const res = await request(
      "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
      cookie,
      "GET",
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      authorizationUrl: string;
      state: string;
    };

    expect(body.state).toBeDefined();
    expect(body.url).toContain("client_id=");
    expect(body.url).toContain(`state=${body.state}`);
    expect(body.url).toContain("code_challenge=");
    expect(body.url).toContain("code_challenge_method=S256");
    expect(body.authorizationUrl).toBe(body.url);

    // Verifica que redirect_uri na URL de autorização aponta exatamente para a URL fixa
    const parsedAuthUrl = new URL(body.url);
    expect(parsedAuthUrl.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/integrations/meta/callback`,
    );
    expect(parsedAuthUrl.searchParams.get("response_type")).toBe("code");
    expect(parsedAuthUrl.searchParams.get("scope")).toBe(
      "pages_show_list,pages_read_engagement,instagram_basic,instagram_content_publish",
    );
    expect(parsedAuthUrl.searchParams.get("config_id")).toBeNull();
    expect(
      parsedAuthUrl.searchParams.get("override_default_response_type"),
    ).toBeNull();

    // Verifica persistência e TTL no Redis
    const stateKey = `meta:oauth:state:${body.state}`;
    const storedRaw = await redis.get(stateKey);
    expect(storedRaw).not.toBeNull();

    const stored = JSON.parse(storedRaw!);
    expect(stored.organizationId).toBe("org-a");
    expect(stored.clientId).toBe("client-a");
    expect(stored.userId).toBe("admin-a");
    expect(stored.codeVerifier).toBeDefined();
    expect(stored.codeChallenge).toBeDefined();

    const ttl = await redis.ttl(stateKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it("authorize inclui config_id e override_default_response_type na URL quando META_CONFIG_ID estiver configurado", async () => {
    const configWithMetaConfig = readConfig({
      ...process.env,
      META_APP_ID: "meta-test-app-id",
      META_APP_SECRET: "meta-test-app-secret",
      META_GRAPH_URL: metaMock.url,
      CREDENTIAL_MASTER_KEY: TEST_KEY_32.toString("hex"),
      META_CONFIG_ID: "1608043467489544",
    });

    const testApp = await createApplication(configWithMetaConfig, {
      socialAccountDependencies: {
        graphBaseUrl: metaMock.url,
        appId: "meta-test-app-id",
        appSecret: "meta-test-app-secret",
        masterKey: TEST_KEY_32,
      },
    });

    await testApp.app.listen(0, "127.0.0.1");
    const serverAddr = testApp.app.getHttpServer().address() as AddressInfo;
    const testBase = `http://127.0.0.1:${serverAddr.port}`;

    try {
      const cookie = await login("admin-a");
      const res = await fetch(
        `${testBase}/api/organizations/org-a/clients/client-a/integrations/meta/authorize`,
        { headers: { cookie, origin } },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        url: string;
        authorizationUrl: string;
      };
      const parsedAuthUrl = new URL(body.authorizationUrl);
      expect(parsedAuthUrl.searchParams.get("config_id")).toBe(
        "1608043467489544",
      );
      expect(
        parsedAuthUrl.searchParams.get("override_default_response_type"),
      ).toBe("true");
      expect(parsedAuthUrl.searchParams.get("response_type")).toBe("code");
      expect(parsedAuthUrl.searchParams.get("scope")).toBeNull();
      expect(parsedAuthUrl.searchParams.get("code_challenge")).toBeTruthy();
      expect(parsedAuthUrl.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
    } finally {
      await testApp.app.close();
    }
  });

  it("rejeita CLIENT_VIEWER na tentativa de autorização com 403", async () => {
    const cookie = await login("viewer-a");
    const res = await request(
      "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
      cookie,
      "GET",
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("Acesso não autorizado");
  });

  it("rejeita autorização para cliente de outra organização com 404", async () => {
    const cookie = await login("admin-a");
    const res = await request(
      "/api/organizations/org-a/clients/client-b/integrations/meta/authorize",
      cookie,
      "GET",
    );
    expect(res.status).toBe(404);
  });

  it("callback válido na URL fixa descobre ativos e associa escopo do state armazenado no servidor", async () => {
    const cookie = await login("admin-a");

    const authRes = await request(
      "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
      cookie,
      "GET",
    );
    expect(authRes.status).toBe(200);
    const { state } = (await authRes.json()) as { state: string };

    const stateRaw = await redis.get(`meta:oauth:state:${state}`);
    const { codeChallenge } = JSON.parse(stateRaw!);

    const code = `valid_callback_code_${randomUUID()}`;
    metaMock.registerCode(code, {
      codeChallenge,
      pages: [
        {
          id: "page_valid_1",
          name: "Facebook Page Valid 1",
          access_token: "mock_token_valid_1",
        },
      ],
    });

    // Chamada à URL fixa sem depender de parâmetros de rota :org ou :clientId
    const callbackRes = await request(
      `/api/integrations/meta/callback?code=${code}&state=${state}`,
      cookie,
      "GET",
    );
    expect(callbackRes.status).toBe(200);
    const discovery = (await callbackRes.json()) as {
      discoveryId: string;
      expiresAt: string;
      assets: Array<{
        platform: string;
        platformAccountId: string;
        name: string;
      }>;
    };

    expect(discovery.discoveryId).toBeDefined();
    expect(discovery.assets).toHaveLength(1);
    expect(discovery.assets[0]?.platformAccountId).toBe("page_valid_1");

    // Verifica que a descoberta armazenada no Redis herdou estritamente o tenant e o usuário do state
    const discoveryRaw = await redis.get(
      `meta:oauth:discovery:${discovery.discoveryId}`,
    );
    expect(discoveryRaw).not.toBeNull();
    const storedDiscovery = JSON.parse(discoveryRaw!);
    expect(storedDiscovery.organizationId).toBe("org-a");
    expect(storedDiscovery.clientId).toBe("client-a");
    expect(storedDiscovery.userId).toBe("admin-a");
  });

  it("callback rejeita state adulterado com 400", async () => {
    const cookie = await login("admin-a");
    const res = await request(
      "/api/integrations/meta/callback?code=some_code&state=tampered_fake_state_123",
      cookie,
      "GET",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("State inválido, expirado ou já utilizado");
  });

  it("callback rejeita state expirado com 400", async () => {
    const cookie = await login("admin-a");

    // Gera um state no Redis e o expira manualmente
    const authRes = await request(
      "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
      cookie,
      "GET",
    );
    const { state } = (await authRes.json()) as { state: string };

    await redis.del(`meta:oauth:state:${state}`);

    const res = await request(
      `/api/integrations/meta/callback?code=any_code&state=${state}`,
      cookie,
      "GET",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("State inválido, expirado ou já utilizado");
  });

  it("callback garante uso único do state (segunda chamada com mesmo state retorna 400)", async () => {
    const cookie = await login("admin-a");

    const authRes = await request(
      "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
      cookie,
      "GET",
    );
    const { state } = (await authRes.json()) as { state: string };

    const stateRaw = await redis.get(`meta:oauth:state:${state}`);
    const { codeChallenge } = JSON.parse(stateRaw!);

    const code = `reuse_code_${randomUUID()}`;
    metaMock.registerCode(code, { codeChallenge });

    // 1ª chamada: consome o state na URL fixa
    const res1 = await request(
      `/api/integrations/meta/callback?code=${code}&state=${state}`,
      cookie,
      "GET",
    );
    expect(res1.status).toBe(200);

    // 2ª chamada com o mesmo state: deve ser rejeitada como já utilizado
    const res2 = await request(
      `/api/integrations/meta/callback?code=${code}&state=${state}`,
      cookie,
      "GET",
    );
    expect(res2.status).toBe(400);
    const body2 = (await res2.json()) as { message: string };
    expect(body2.message).toContain("State inválido, expirado ou já utilizado");
  });

  it("callback rejeita sessão diferente do state com 403", async () => {
    const cookieA = await login("admin-a");
    const cookieB = await login("admin-b");

    // Gera state para admin-a
    const authRes = await request(
      "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
      cookieA,
      "GET",
    );
    const { state } = (await authRes.json()) as { state: string };

    const stateRaw = await redis.get(`meta:oauth:state:${state}`);
    const { codeChallenge } = JSON.parse(stateRaw!);
    const code = `diff_session_${randomUUID()}`;
    metaMock.registerCode(code, { codeChallenge });

    // Outro usuário (com outro cookie/sessão) tenta consumir o state
    const res = await request(
      `/api/integrations/meta/callback?code=${code}&state=${state}`,
      cookieB,
      "GET",
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain(
      "Tentativa de manipulação de escopo entre tenants, usuários ou sessões detectada.",
    );
  });

  it("callback revalida permissões e rejeita permissão revogada antes do retorno com 403", async () => {
    const cookie = await login("editor-a");

    // Gera state enquanto o usuário ainda possui papel EDITOR
    const authRes = await request(
      "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
      cookie,
      "GET",
    );
    expect(authRes.status).toBe(200);
    const { state } = (await authRes.json()) as { state: string };

    const stateRaw = await redis.get(`meta:oauth:state:${state}`);
    const { codeChallenge } = JSON.parse(stateRaw!);
    const code = `revoked_perm_${randomUUID()}`;
    metaMock.registerCode(code, { codeChallenge });

    // Revoga permissão rebaixando o usuário para CLIENT_VIEWER antes de executar o callback
    const membership = await migration.membership.findFirstOrThrow({
      where: {
        userId: "editor-a",
        organizationId: "org-a",
        clientId: "client-a",
      },
    });
    await migration.membership.update({
      where: { id: membership.id },
      data: { role: "CLIENT_VIEWER" },
    });

    try {
      // Callback com o mesmo cookie e state é rejeitado pela revalidação de permissão em banco
      const res = await request(
        `/api/integrations/meta/callback?code=${code}&state=${state}`,
        cookie,
        "GET",
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain(
        "Acesso não autorizado para o seu perfil.",
      );
    } finally {
      // Restaura a role de EDITOR
      await migration.membership.update({
        where: { id: membership.id },
        data: { role: "EDITOR" },
      });
    }
  });

  it("callback não aceita redirect_uri ou destino de redirecionamento arbitrário fornecido pelo cliente", async () => {
    const cookie = await login("admin-a");

    const authRes = await request(
      "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
      cookie,
      "GET",
    );
    const { state } = (await authRes.json()) as { state: string };

    // Tentativa de injetar redirect_uri arbitrário
    const resWithArbitraryRedirect = await request(
      `/api/integrations/meta/callback?code=some_code&state=${state}&redirect_uri=https://evil.attacker.com/steal`,
      cookie,
      "GET",
    );
    expect(resWithArbitraryRedirect.status).toBe(400);

    // Tentativa de injetar parâmetro de destino arbitrário
    const resWithArbitraryDestination = await request(
      `/api/integrations/meta/callback?code=some_code&state=${state}&redirect_to=https://evil.attacker.com/steal`,
      cookie,
      "GET",
    );
    expect(resWithArbitraryDestination.status).toBe(400);
  });

  it("callback funciona sem header Origin (navegação real do browser vindo da Meta) e preserva Origin nos demais endpoints", async () => {
    const cookie = await login("admin-a");

    const authRes = await request(
      "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
      cookie,
      "GET",
    );
    const { state } = (await authRes.json()) as { state: string };

    const stateRaw = await redis.get(`meta:oauth:state:${state}`);
    const { codeChallenge } = JSON.parse(stateRaw!);
    const code = `no_origin_browser_${randomUUID()}`;
    metaMock.registerCode(code, {
      codeChallenge,
      pages: [
        {
          id: "page_browser_nav",
          name: "Page Browser Nav",
          access_token: "mock_nav_token",
        },
      ],
    });

    // Requisição GET para o callback sem enviar header Origin (navegação do navegador)
    const callbackRes = await fetch(
      `${apiBase}/api/integrations/meta/callback?code=${code}&state=${state}`,
      {
        method: "GET",
        headers: {
          cookie,
          // Sem header Origin
        },
      },
    );
    expect(callbackRes.status).toBe(200);
    const discovery = (await callbackRes.json()) as { discoveryId: string };
    expect(discovery.discoveryId).toBeDefined();

    // Endpoint de mutação (POST /social-accounts/connect) SEM header Origin é rejeitado com 403
    const connectResWithoutOrigin = await fetch(
      `${apiBase}/api/organizations/org-a/clients/client-a/social-accounts/connect`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          // Sem header Origin
        },
        body: JSON.stringify({
          discoveryId: discovery.discoveryId,
          selectedAssets: [
            {
              platform: "FACEBOOK_PAGE",
              platformAccountId: "page_browser_nav",
            },
          ],
        }),
      },
    );
    expect(connectResWithoutOrigin.status).toBe(403);
    const connectBody = (await connectResWithoutOrigin.json()) as {
      message: string;
    };
    expect(connectBody.message).toContain("Origem não autorizada");
  });

  it("callback rejeita code_verifier inválido com 400 via mock da Graph API", async () => {
    const cookie = await login("admin-a");

    const authRes = await request(
      "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
      cookie,
      "GET",
    );
    const { state } = (await authRes.json()) as { state: string };

    // Registra code exigindo um challenge diferente do gravado no Redis
    const code = `invalid_pkce_${randomUUID()}`;
    const differentChallenge = createHash("sha256")
      .update("completely_different_verifier")
      .digest("base64url");
    metaMock.registerCode(code, { codeChallenge: differentChallenge });

    const res = await request(
      `/api/integrations/meta/callback?code=${code}&state=${state}`,
      cookie,
      "GET",
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("Invalid code_verifier");
  });

  async function performOAuthDiscovery(
    cookie: string,
    codeOptions?: Parameters<typeof metaMock.registerCode>[1],
    org = "org-a",
    client = "client-a",
  ) {
    const authRes = await request(
      `/api/organizations/${org}/clients/${client}/integrations/meta/authorize`,
      cookie,
      "GET",
    );
    expect(authRes.status).toBe(200);
    const { state } = (await authRes.json()) as { state: string };
    const stateRaw = await redis.get(`meta:oauth:state:${state}`);
    const { codeChallenge } = JSON.parse(stateRaw!);

    const code = `code_${randomUUID()}`;
    metaMock.registerCode(code, { codeChallenge, ...codeOptions });

    const callbackRes = await request(
      `/api/integrations/meta/callback?code=${code}&state=${state}`,
      cookie,
      "GET",
    );
    expect(callbackRes.status).toBe(200);
    return { authRes, callbackRes, code, state };
  }

  it("endpoint de descoberta retorna apenas DTOs sanitizados e valida escopo e expiração", async () => {
    const cookie = await login("admin-a");
    const { callbackRes } = await performOAuthDiscovery(cookie, {
      userAccessToken: "token_for_discovery_query",
      pages: [
        {
          id: "page_disc_query_1",
          name: "Page Discovery Test",
          access_token: "mock_page_token_query",
          instagramBusinessAccount: {
            id: "ig_disc_query_1",
            username: "ig_disc_query",
            name: "IG Discovery Test",
          },
        },
      ],
    });

    const disc = (await callbackRes.json()) as { discoveryId: string };
    expect(disc.discoveryId).toBeDefined();

    // 1. Consulta com sucesso pelo admin autenticado
    const queryRes = await request(
      `/api/organizations/org-a/clients/client-a/integrations/meta/discovery/${disc.discoveryId}`,
      cookie,
      "GET",
    );
    expect(queryRes.status).toBe(200);
    const queried = (await queryRes.json()) as {
      discoveryId: string;
      expiresAt: string;
      assets: Array<{
        platform: string;
        platformAccountId: string;
        name: string;
        username?: string | null;
      }>;
    };
    expect(queried.discoveryId).toBe(disc.discoveryId);
    expect(queried.assets).toHaveLength(2);
    // Garante que nenhum token, IV ou authTag é exposto no DTO sanitizado
    expect(queried).not.toHaveProperty("encryptedAccessToken");
    expect(queried).not.toHaveProperty("assets.0.encryptedAccessToken");

    // 2. Rejeita discoveryId inexistente
    const notFoundRes = await request(
      `/api/organizations/org-a/clients/client-a/integrations/meta/discovery/${randomUUID()}`,
      cookie,
      "GET",
    );
    expect(notFoundRes.status).toBe(404);

    // 3. Rejeita consulta por outro tenant/cliente inexistente na organização
    const otherClientRes = await request(
      `/api/organizations/org-a/clients/client-b/integrations/meta/discovery/${disc.discoveryId}`,
      cookie,
      "GET",
    );
    expect([403, 404]).toContain(otherClientRes.status);

    // 4. Rejeita consulta por outro usuário
    const otherUserCookie = await login("editor-a");
    const otherUserRes = await request(
      `/api/organizations/org-a/clients/client-a/integrations/meta/discovery/${disc.discoveryId}`,
      otherUserCookie,
      "GET",
    );
    expect(otherUserRes.status).toBe(403);

    // 5. Rejeita se CLIENT_VIEWER tentar consultar
    const viewerCookie = await login("viewer-a");
    const viewerRes = await request(
      `/api/organizations/org-a/clients/client-a/integrations/meta/discovery/${disc.discoveryId}`,
      viewerCookie,
      "GET",
    );
    expect(viewerRes.status).toBe(403);
  });

  it("navegação de navegador no callback realiza redirecionamento 302 sem expor tokens na URL", async () => {
    const cookie = await login("admin-a");
    const authRes = await request(
      "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
      cookie,
      "GET",
    );
    const { state } = (await authRes.json()) as { state: string };

    const stateRaw = await redis.get(`meta:oauth:state:${state}`);
    const { codeChallenge } = JSON.parse(stateRaw!);

    const code = `code_browser_${randomUUID()}`;
    metaMock.registerCode(code, {
      codeChallenge,
      pages: [{ id: "page_browser_1", name: "Browser Nav Page" }],
    });

    // Simula navegação top-level do navegador vindo da Meta (Accept: text/html, redirect manual)
    const callbackRes = await request(
      `/api/integrations/meta/callback?code=${code}&state=${state}`,
      cookie,
      "GET",
      undefined,
      "application/json",
      origin,
      {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      "manual",
    );

    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get("location");
    expect(location).toBeDefined();
    expect(location).toContain("/?org=org-a&client=client-a&discoveryId=");
    // Garante que tokens, códigos ou segredos NÃO estão na URL de redirecionamento
    expect(location).not.toContain("code=");
    expect(location).not.toContain("access_token");
    expect(location).not.toContain("state=");
  });

  it("cancelamento de consentimento na Meta consome state e redireciona com mensagem amigável", async () => {
    const cookie = await login("admin-a");
    const authRes = await request(
      "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
      cookie,
      "GET",
    );
    const { state } = (await authRes.json()) as { state: string };

    // Usuário clica em cancelar no fluxo de consentimento da Meta
    const cancelRes = await request(
      `/api/integrations/meta/callback?error=access_denied&error_code=200&error_description=Permissions+error&error_reason=user_denied&state=${state}`,
      cookie,
      "GET",
      undefined,
      "application/json",
      origin,
      { accept: "text/html,application/xhtml+xml,*/*" },
      "manual",
    );

    expect(cancelRes.status).toBe(302);
    const location = cancelRes.headers.get("location");
    expect(location).toBeDefined();
    expect(location).toContain("meta_error=consent_cancelled");
    expect(location).toContain("org=org-a");
    expect(location).toContain("client=client-a");

    // State deve ter sido consumido e removido do Redis
    const remaining = await redis.get(`meta:oauth:state:${state}`);
    expect(remaining).toBeNull();
  });

  it("descoberta com páginas de clientes diferentes não vincula nenhuma automaticamente", async () => {
    const cookie = await login("admin-a");

    const { callbackRes } = await performOAuthDiscovery(cookie, {
      userAccessToken: "mock_user_token_discovery",
      pages: [
        {
          id: "page_multi_1",
          name: "Facebook Page Client 1",
          access_token: "mock_page_token_1",
        },
        {
          id: "page_multi_2",
          name: "Facebook Page Client 2",
          access_token: "mock_page_token_2",
          instagramBusinessAccount: {
            id: "ig_multi_2",
            username: "ig_client_2",
            name: "Instagram Client 2",
          },
        },
      ],
    });

    expect(callbackRes.status).toBe(200);
    const discovery = (await callbackRes.json()) as {
      discoveryId: string;
      expiresAt: string;
      assets: Array<{
        platform: string;
        platformAccountId: string;
        name: string;
        linkedFacebookPageId?: string | null;
      }>;
    };

    expect(discovery.discoveryId).toBeDefined();
    expect(discovery.assets).toHaveLength(3);

    // Escopo 1: Nenhuma conta ou credencial foi persistida no banco de dados
    const dbAccounts = await migration.socialAccount.findMany({
      where: { clientId: "client-a" },
    });
    expect(dbAccounts).toEqual([]);

    const dbCreds = await migration.oAuthCredential.findMany({});
    expect(dbCreds).toEqual([]);

    // Escopo 2: Descoberta armazenada temporariamente no Redis com TTL <= 600s
    const discoveryKey = `meta:oauth:discovery:${discovery.discoveryId}`;
    const ttl = await redis.ttl(discoveryKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it("seleção de uma página não vincula as demais, persiste credencial criptografada e consome descoberta", async () => {
    const cookie = await login("admin-a");

    const { callbackRes } = await performOAuthDiscovery(cookie, {
      userAccessToken: "mock_user_token_explicit",
      pages: [
        {
          id: "page_select_A",
          name: "Page To Connect",
          access_token: "mock_page_token_A",
        },
        {
          id: "page_select_B",
          name: "Page To Ignore",
          access_token: "mock_page_token_B",
        },
      ],
    });

    const discovery = (await callbackRes.json()) as {
      discoveryId: string;
      assets: Array<{ platform: "FACEBOOK_PAGE"; platformAccountId: string }>;
    };

    // Conecta exclusivamente a page_select_A
    const connectRes = await request(
      "/api/organizations/org-a/clients/client-a/social-accounts/connect",
      cookie,
      "POST",
      {
        discoveryId: discovery.discoveryId,
        selectedAssets: [
          { platform: "FACEBOOK_PAGE", platformAccountId: "page_select_A" },
        ],
      },
    );

    expect(connectRes.status).toBe(200);
    const connectBody = (await connectRes.json()) as {
      connectedAccounts: Array<{
        id: string;
        platform: string;
        platformAccountId: string;
        status: string;
      }>;
    };
    expect(connectBody.connectedAccounts).toHaveLength(1);
    expect(connectBody.connectedAccounts[0]?.platformAccountId).toBe(
      "page_select_A",
    );

    // Confirma que APENAS page_select_A foi gravada; page_select_B não existe
    const accountA = await migration.socialAccount.findFirst({
      where: {
        organizationId: "org-a",
        clientId: "client-a",
        platformAccountId: "page_select_A",
      },
    });
    expect(accountA).not.toBeNull();
    expect(accountA?.status).toBe("ACTIVE");

    const accountB = await migration.socialAccount.findFirst({
      where: { platformAccountId: "page_select_B" },
    });
    expect(accountB).toBeNull();

    // Confirma criptografia da credencial com AES-256-GCM + AAD
    const credA = await migration.oAuthCredential.findUnique({
      where: { socialAccountId: accountA!.id },
    });
    expect(credA).not.toBeNull();
    expect(credA?.encryptedAccessToken).not.toBe("mock_page_token_A");

    const crypto = createCredentialCrypto(TEST_KEY_32, 1);
    const decrypted = crypto.decrypt(
      {
        encryptedAccessToken: credA!.encryptedAccessToken,
        iv: credA!.iv,
        authTag: credA!.authTag,
        keyVersion: credA!.keyVersion,
      },
      {
        organizationId: "org-a",
        clientId: "client-a",
        platformAccountId: "page_select_A",
        keyVersion: 1,
      },
    );
    expect(decrypted).toBe("mock_page_token_A");

    // Tentativa de decriptar com tenant incorreto falha
    expect(() =>
      crypto.decrypt(
        {
          encryptedAccessToken: credA!.encryptedAccessToken,
          iv: credA!.iv,
          authTag: credA!.authTag,
          keyVersion: credA!.keyVersion,
        },
        {
          organizationId: "org-b",
          clientId: "client-a",
          platformAccountId: "page_select_A",
          keyVersion: 1,
        },
      ),
    ).toThrow(CryptoError);

    // Consumo de descoberta: chave do Redis foi excluída
    const redisAfter = await redis.get(
      `meta:oauth:discovery:${discovery.discoveryId}`,
    );
    expect(redisAfter).toBeNull();

    // Consumo no PostgreSQL é gravado na mesma transação
    const consumption = await migration.oAuthDiscoveryConsumption.findUnique({
      where: { discoveryId: discovery.discoveryId },
    });
    expect(consumption).not.toBeNull();
    expect(consumption?.organizationId).toBe("org-a");
    expect(consumption?.clientId).toBe("client-a");
    expect(consumption?.userId).toBe("admin-a");
    expect(consumption?.connectedAccountIds).toEqual([accountA!.id]);

    // Repetição idêntica após commit é idempotente: retorna 200 sem nova auditoria
    const auditCountBefore = await migration.auditLog.count({
      where: { entityId: accountA!.id, action: "social_account.connected" },
    });
    expect(auditCountBefore).toBe(1);

    const retryRes = await request(
      "/api/organizations/org-a/clients/client-a/social-accounts/connect",
      cookie,
      "POST",
      {
        discoveryId: discovery.discoveryId,
        selectedAssets: [
          { platform: "FACEBOOK_PAGE", platformAccountId: "page_select_A" },
        ],
      },
    );
    expect(retryRes.status).toBe(200);
    const retryBody = (await retryRes.json()) as {
      connectedAccounts: Array<{ platformAccountId: string }>;
    };
    expect(retryBody.connectedAccounts).toHaveLength(1);
    expect(retryBody.connectedAccounts[0]?.platformAccountId).toBe(
      "page_select_A",
    );

    const auditCountAfter = await migration.auditLog.count({
      where: { entityId: accountA!.id, action: "social_account.connected" },
    });
    expect(auditCountAfter).toBe(1); // Não gerou nova auditoria!

    // Repetição com seleção diferente é rejeitada com 409 sem alterar a seleção original
    const differentSelectionRes = await request(
      "/api/organizations/org-a/clients/client-a/social-accounts/connect",
      cookie,
      "POST",
      {
        discoveryId: discovery.discoveryId,
        selectedAssets: [
          { platform: "FACEBOOK_PAGE", platformAccountId: "page_select_B" },
        ],
      },
    );
    expect(differentSelectionRes.status).toBe(409);
    const diffBody = (await differentSelectionRes.json()) as {
      message: string;
    };
    expect(diffBody.message).toContain("seleção diferente de ativos");

    // Confirma que page_select_B continua não existindo
    const accountBStillNull = await migration.socialAccount.findFirst({
      where: { platformAccountId: "page_select_B" },
    });
    expect(accountBStillNull).toBeNull();
  });

  it("rejeita ativo inventado, descoberta expirada, outro usuário/sessão/tenant e permissão revogada", async () => {
    const cookieAdminA = await login("admin-a");
    const cookieAdminB = await login("admin-b");

    const { callbackRes } = await performOAuthDiscovery(cookieAdminA);
    const discovery = (await callbackRes.json()) as {
      discoveryId: string;
      assets: Array<{ platform: string; platformAccountId: string }>;
    };

    // 1. Rejeita ativo inventado (não contido na descoberta)
    const fakeAssetRes = await request(
      "/api/organizations/org-a/clients/client-a/social-accounts/connect",
      cookieAdminA,
      "POST",
      {
        discoveryId: discovery.discoveryId,
        selectedAssets: [
          {
            platform: "FACEBOOK_PAGE",
            platformAccountId: "invented_page_99999",
          },
        ],
      },
    );
    expect(fakeAssetRes.status).toBe(400);
    const fakeBody = (await fakeAssetRes.json()) as { message: string };
    expect(fakeBody.message).toContain(
      "não encontrado na sessão de descoberta",
    );

    // 2. Rejeita descoberta expirada ou inexistente
    const expiredRes = await request(
      "/api/organizations/org-a/clients/client-a/social-accounts/connect",
      cookieAdminA,
      "POST",
      {
        discoveryId: randomUUID(),
        selectedAssets: [
          { platform: "FACEBOOK_PAGE", platformAccountId: "any_id" },
        ],
      },
    );
    expect(expiredRes.status).toBe(400);
    const expiredBody = (await expiredRes.json()) as { message: string };
    expect(expiredBody.message).toContain("expirada, inválida ou já utilizada");

    // 3. Rejeita tentativa de outro tenant/usuário usando a mesma descoberta
    const crossTenantRes = await request(
      "/api/organizations/org-b/clients/client-b/social-accounts/connect",
      cookieAdminB,
      "POST",
      {
        discoveryId: discovery.discoveryId,
        selectedAssets: [
          {
            platform: discovery.assets[0]!.platform,
            platformAccountId: discovery.assets[0]!.platformAccountId,
          },
        ],
      },
    );
    expect(crossTenantRes.status).toBe(403);
    const crossBody = (await crossTenantRes.json()) as { message: string };
    expect(crossBody.message).toContain("manipulação de escopo entre tenants");

    // 4. Rejeita tentativa de outra sessão (novo login do mesmo usuário)
    const newSessionCookie = await login("admin-a");
    const otherSessionRes = await request(
      "/api/organizations/org-a/clients/client-a/social-accounts/connect",
      newSessionCookie,
      "POST",
      {
        discoveryId: discovery.discoveryId,
        selectedAssets: [
          {
            platform: discovery.assets[0]!.platform,
            platformAccountId: discovery.assets[0]!.platformAccountId,
          },
        ],
      },
    );
    expect(otherSessionRes.status).toBe(403);

    // 5. Rejeita quando permissão do usuário for revogada
    const cookieEditor = await login("editor-a");
    const { callbackRes: editorCallbackRes } =
      await performOAuthDiscovery(cookieEditor);
    const editorDiscovery = (await editorCallbackRes.json()) as {
      discoveryId: string;
      assets: Array<{ platform: string; platformAccountId: string }>;
    };

    // Revoga permissão (rebaixa role para CLIENT_VIEWER)
    await migration.membership.updateMany({
      where: { organizationId: "org-a", userId: "editor-a" },
      data: { role: "CLIENT_VIEWER" },
    });

    try {
      const revokedRes = await request(
        "/api/organizations/org-a/clients/client-a/social-accounts/connect",
        cookieEditor,
        "POST",
        {
          discoveryId: editorDiscovery.discoveryId,
          selectedAssets: [
            {
              platform: editorDiscovery.assets[0]!.platform,
              platformAccountId: editorDiscovery.assets[0]!.platformAccountId,
            },
          ],
        },
      );
      expect(revokedRes.status).toBe(403);
    } finally {
      // Restaura permissão de editor
      await migration.membership.updateMany({
        where: { organizationId: "org-a", userId: "editor-a" },
        data: { role: "EDITOR" },
      });
    }
  });

  it("requisições simultâneas não duplicam vínculos ou auditorias", async () => {
    const cookie = await login("admin-a");

    const { callbackRes } = await performOAuthDiscovery(cookie, {
      pages: [
        {
          id: "page_concurrent_1",
          name: "Concurrent Test Page",
          access_token: "mock_page_token_concurrent",
        },
      ],
    });

    const discovery = (await callbackRes.json()) as {
      discoveryId: string;
    };

    const payload = {
      discoveryId: discovery.discoveryId,
      selectedAssets: [
        {
          platform: "FACEBOOK_PAGE",
          platformAccountId: "page_concurrent_1",
        },
      ],
    };

    // Duas requisições rigorosamente simultâneas com a mesma descoberta
    const [res1, res2] = await Promise.all([
      request(
        "/api/organizations/org-a/clients/client-a/social-accounts/connect",
        cookie,
        "POST",
        payload,
      ),
      request(
        "/api/organizations/org-a/clients/client-a/social-accounts/connect",
        cookie,
        "POST",
        payload,
      ),
    ]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    // Exatamente uma teve sucesso (200) e a outra foi barrada (409 lock ou 400 consumida)
    expect(statuses[0]).toBe(200);
    expect([400, 409]).toContain(statuses[1]);

    // Confirma que não houve duplicação de vínculo no PostgreSQL
    const accounts = await migration.socialAccount.findMany({
      where: {
        organizationId: "org-a",
        clientId: "client-a",
        platformAccountId: "page_concurrent_1",
      },
    });
    expect(accounts).toHaveLength(1);

    // Confirma que não houve duplicação de auditoria
    const audits = await migration.auditLog.findMany({
      where: {
        entityId: accounts[0]!.id,
        action: "social_account.connected",
      },
    });
    expect(audits).toHaveLength(1);
  });

  it("falha transacional não deixa persistência parcial e preserva sessão de descoberta no Redis", async () => {
    const cookie = await login("admin-a");

    const { callbackRes } = await performOAuthDiscovery(cookie, {
      pages: [
        {
          id: "page_atomic_valid",
          name: "Page Atomic Valid",
          access_token: "mock_page_token_atom_1",
        },
        {
          id: "page_atomic_fail",
          name: "Page Atomic Trigger Fail",
          access_token: "mock_page_token_atom_2",
        },
      ],
    });

    const discovery = (await callbackRes.json()) as {
      discoveryId: string;
      assets: Array<{ platform: string; platformAccountId: string }>;
    };

    // Cria um trigger temporário no PostgreSQL para forçar erro ao inserir page_atomic_fail
    await migration.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_on_magic_id() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW."platformAccountId" = 'page_atomic_fail' THEN
          RAISE EXCEPTION 'simulated_tx_abort_for_testing';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await migration.$executeRawUnsafe(`
      CREATE TRIGGER trg_test_tx_abort
      BEFORE INSERT ON "SocialAccount"
      FOR EACH ROW EXECUTE FUNCTION fail_on_magic_id();
    `);

    try {
      const connectRes = await request(
        "/api/organizations/org-a/clients/client-a/social-accounts/connect",
        cookie,
        "POST",
        {
          discoveryId: discovery.discoveryId,
          selectedAssets: [
            {
              platform: "FACEBOOK_PAGE",
              platformAccountId: "page_atomic_valid",
            },
            {
              platform: "FACEBOOK_PAGE",
              platformAccountId: "page_atomic_fail",
            },
          ],
        },
      );

      // Endpoint falhou devido ao rollback do banco
      expect([500, 503]).toContain(connectRes.status);

      // Não houve persistência parcial: a primeira conta não permaneceu gravada
      const validAccount = await migration.socialAccount.findFirst({
        where: { platformAccountId: "page_atomic_valid" },
      });
      expect(validAccount).toBeNull();

      // Nenhuma credencial foi salva
      const creds = await migration.oAuthCredential.findMany({
        where: {
          socialAccount: {
            platformAccountId: {
              in: ["page_atomic_valid", "page_atomic_fail"],
            },
          },
        },
      });
      expect(creds).toHaveLength(0);

      // Sessão de descoberta no Redis foi preservada (pois a transação falhou e o del ocorre pós-commit)
      const discoveryKey = `meta:oauth:discovery:${discovery.discoveryId}`;
      const preservedRaw = await redis.get(discoveryKey);
      expect(preservedRaw).not.toBeNull();

      // O lock de concorrência foi liberado no finally, permitindo nova tentativa
      const lockKey = `meta:oauth:discovery:lock:${discovery.discoveryId}`;
      const lockRaw = await redis.get(lockKey);
      expect(lockRaw).toBeNull();
    } finally {
      // Remove o trigger temporário
      await migration.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS trg_test_tx_abort ON "SocialAccount";',
      );
      await migration.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS fail_on_magic_id();",
      );
    }
  });

  it("garante que tokens não aparecem em respostas, logs, nem em texto aberto no Redis", async () => {
    const cookie = await login("admin-a");

    const { callbackRes } = await performOAuthDiscovery(cookie, {
      userAccessToken: "super_secret_user_token_never_leak",
      pages: [
        {
          id: "page_leak_test",
          name: "Leak Test Page",
          access_token: "super_secret_page_token_never_leak",
        },
      ],
    });

    // 1. Resposta do callback
    const callbackText = await callbackRes.text();
    expect(callbackText).not.toContain("super_secret_user_token_never_leak");
    expect(callbackText).not.toContain("super_secret_page_token_never_leak");
    expect(callbackText).not.toContain("encryptedAccessToken");
    expect(callbackText).not.toContain("authTag");
    expect(callbackText).not.toContain("iv");

    const discovery = JSON.parse(callbackText) as { discoveryId: string };

    // 2. Texto cru armazenado no Redis não contém tokens em texto aberto
    const discoveryKey = `meta:oauth:discovery:${discovery.discoveryId}`;
    const redisRaw = await redis.get(discoveryKey);
    expect(redisRaw).not.toBeNull();
    expect(redisRaw).not.toContain("super_secret_user_token_never_leak");
    expect(redisRaw).not.toContain("super_secret_page_token_never_leak");

    // 3. Resposta do connect
    const connectRes = await request(
      "/api/organizations/org-a/clients/client-a/social-accounts/connect",
      cookie,
      "POST",
      {
        discoveryId: discovery.discoveryId,
        selectedAssets: [
          { platform: "FACEBOOK_PAGE", platformAccountId: "page_leak_test" },
        ],
      },
    );
    const connectText = await connectRes.text();
    expect(connectText).not.toContain("super_secret_user_token_never_leak");
    expect(connectText).not.toContain("super_secret_page_token_never_leak");
    expect(connectText).not.toContain("encryptedAccessToken");
    expect(connectText).not.toContain("authTag");
    expect(connectText).not.toContain("iv");

    // 4. Resposta do GET listagem
    const listRes = await request(
      "/api/organizations/org-a/clients/client-a/social-accounts",
      cookie,
      "GET",
    );
    const listText = await listRes.text();
    expect(listText).not.toContain("super_secret_user_token_never_leak");
    expect(listText).not.toContain("super_secret_page_token_never_leak");
    expect(listText).not.toContain("encryptedAccessToken");
  });

  it("CLIENT_VIEWER não pode executar callback, connect ou desconectar contas com 403", async () => {
    const cookieViewer = await login("viewer-a");
    const cookieAdmin = await login("admin-a");

    // 1. Viewer tenta callback com state de outro usuário/sessão
    const authRes = await request(
      "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
      cookieAdmin,
      "GET",
    );
    const { state: adminState } = (await authRes.json()) as { state: string };

    const callbackRes = await request(
      `/api/integrations/meta/callback?code=any&state=${adminState}`,
      cookieViewer,
      "GET",
    );
    expect(callbackRes.status).toBe(403);
    const callbackBody = (await callbackRes.json()) as { message: string };
    expect(callbackBody.message).toContain(
      "Tentativa de manipulação de escopo entre tenants, usuários ou sessões detectada.",
    );

    // 2. Admin descobre ativos
    const { callbackRes: adminDiscoveryRes } =
      await performOAuthDiscovery(cookieAdmin);
    const discovery = (await adminDiscoveryRes.json()) as {
      discoveryId: string;
      assets: Array<{ platform: string; platformAccountId: string }>;
    };

    // 3. Viewer tenta conectar ativos com 403
    const viewerConnectRes = await request(
      "/api/organizations/org-a/clients/client-a/social-accounts/connect",
      cookieViewer,
      "POST",
      {
        discoveryId: discovery.discoveryId,
        selectedAssets: [
          {
            platform: discovery.assets[0]!.platform,
            platformAccountId: discovery.assets[0]!.platformAccountId,
          },
        ],
      },
    );
    expect(viewerConnectRes.status).toBe(403);

    // 4. Admin conecta
    const adminConnectRes = await request(
      "/api/organizations/org-a/clients/client-a/social-accounts/connect",
      cookieAdmin,
      "POST",
      {
        discoveryId: discovery.discoveryId,
        selectedAssets: [
          {
            platform: discovery.assets[0]!.platform,
            platformAccountId: discovery.assets[0]!.platformAccountId,
          },
        ],
      },
    );
    const connectBody = (await adminConnectRes.json()) as {
      connectedAccounts: Array<{ id: string }>;
    };
    const accountId = connectBody.connectedAccounts[0]?.id;
    expect(accountId).toBeDefined();

    // 5. Viewer tenta desconectar a conta com 403
    const deleteRes = await request(
      `/api/organizations/org-a/clients/client-a/social-accounts/${accountId}`,
      cookieViewer,
      "DELETE",
    );
    expect(deleteRes.status).toBe(403);
  });

  it("GET de contas sociais por cliente lista contas sanitizadas e permite CLIENT_VIEWER visualizar", async () => {
    const cookieViewer = await login("viewer-a");

    const res = await request(
      "/api/organizations/org-a/clients/client-a/social-accounts",
      cookieViewer,
      "GET",
    );

    expect(res.status).toBe(200);
    const accounts = (await res.json()) as Array<{
      id: string;
      platform: string;
      name: string;
      status: string;
    }>;
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.length).toBeGreaterThan(0);
  });

  it("DELETE de conta social desconecta, remove credencial com segurança, registra AuditLog e preserva histórico de publicação", async () => {
    const cookieAdmin = await login("admin-a");

    // Conecta conta para teste de desconexão
    const { callbackRes } = await performOAuthDiscovery(cookieAdmin, {
      pages: [
        {
          id: "page_disconnect_preservation",
          name: "Page To Disconnect",
          access_token: "mock_page_token_disconn",
        },
      ],
    });

    const discovery = (await callbackRes.json()) as {
      discoveryId: string;
      assets: Array<{ platform: string; platformAccountId: string }>;
    };

    const connRes = await request(
      "/api/organizations/org-a/clients/client-a/social-accounts/connect",
      cookieAdmin,
      "POST",
      {
        discoveryId: discovery.discoveryId,
        selectedAssets: [
          {
            platform: "FACEBOOK_PAGE",
            platformAccountId: "page_disconnect_preservation",
          },
        ],
      },
    );
    const connBody = (await connRes.json()) as {
      connectedAccounts: Array<{ id: string }>;
    };
    const targetAccountId = connBody.connectedAccounts[0]?.id;
    expect(targetAccountId).toBeDefined();

    // Cria um Post e uma tentativa de publicação (PublicationAttempt)
    const post = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        caption: "Post histórico de teste de desconexão",
        status: "APPROVED",
      },
    });

    const pubAttempt = await migration.publicationAttempt.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        postId: post.id,
        socialAccountId: targetAccountId!,
        status: "PENDING",
      },
    });

    // Confirma que a credencial existe antes
    const credBefore = await migration.oAuthCredential.findUnique({
      where: { socialAccountId: targetAccountId },
    });
    expect(credBefore).not.toBeNull();

    // Executa DELETE (desconexão)
    const deleteRes = await request(
      `/api/organizations/org-a/clients/client-a/social-accounts/${targetAccountId}`,
      cookieAdmin,
      "DELETE",
    );

    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as {
      disconnected: boolean;
      id: string;
      status: string;
    };
    expect(deleteBody.disconnected).toBe(true);
    expect(deleteBody.id).toBe(targetAccountId);
    expect(deleteBody.status).toBe("DISCONNECTED");

    // Confirma no banco que status foi atualizado para DISCONNECTED
    const accountAfter = await migration.socialAccount.findUnique({
      where: { id: targetAccountId },
    });
    expect(accountAfter?.status).toBe("DISCONNECTED");

    // Confirma no banco que a credencial foi removida com segurança
    const credAfter = await migration.oAuthCredential.findUnique({
      where: { socialAccountId: targetAccountId },
    });
    expect(credAfter).toBeNull();

    // Confirma que o histórico de publicação (PublicationAttempt) continua integro e preservado
    const attemptAfter = await migration.publicationAttempt.findUnique({
      where: { id: pubAttempt.id },
    });
    expect(attemptAfter).not.toBeNull();
    expect(attemptAfter?.status).toBe("PENDING");
    expect(attemptAfter?.socialAccountId).toBe(targetAccountId);

    // Confirma registro no AuditLog
    const auditLogs = await migration.auditLog.findMany({
      where: {
        entityId: targetAccountId,
        action: "social_account.disconnected",
      },
    });
    expect(auditLogs.length).toBeGreaterThan(0);
    expect(auditLogs[0]?.actorUserId).toBe("admin-a");
    expect(auditLogs[0]?.organizationId).toBe("org-a");
  });

  it("trata falha do Redis após commit como falha de limpeza, preservando resultado confirmado no PostgreSQL e sem vazar segredos", async () => {
    const FAKE_SECRET = "SUPER_SECRET_REDIS_AUTH_xyz987654321";
    const consoleErrorSpy = vi.spyOn(console, "error");

    const customConfig = readConfig({
      ...process.env,
      META_APP_ID: "meta-test-app-id",
      META_APP_SECRET: "meta-test-app-secret",
      META_GRAPH_URL: metaMock.url,
      CREDENTIAL_MASTER_KEY: TEST_KEY_32.toString("hex"),
    });

    const customApp = await createApplication(customConfig, {
      socialAccountDependencies: {
        graphBaseUrl: metaMock.url,
        appId: "meta-test-app-id",
        appSecret: "meta-test-app-secret",
        masterKey: TEST_KEY_32,
        cleanupDiscovery: async () => {
          throw new Error(`Redis connection dropped with token=${FAKE_SECRET}`);
        },
      },
    });

    await customApp.app.listen(0, "127.0.0.1");
    const serverAddr = customApp.app.getHttpServer().address() as AddressInfo;
    const customBase = `http://127.0.0.1:${serverAddr.port}`;

    try {
      const cookie = await login("admin-a");

      const authRes = await fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/integrations/meta/authorize`,
        { headers: { cookie, origin } },
      );
      const { state } = (await authRes.json()) as { state: string };
      const stateRaw = await redis.get(`meta:oauth:state:${state}`);
      const { codeChallenge } = JSON.parse(stateRaw!);

      const code = `cleanup_fail_code_${randomUUID()}`;
      metaMock.registerCode(code, {
        codeChallenge,
        pages: [
          {
            id: "page_cleanup_fail",
            name: "Page Cleanup Fail Test",
            access_token: "mock_cleanup_token",
          },
        ],
      });

      const callbackRes = await fetch(
        `${customBase}/api/integrations/meta/callback?code=${code}&state=${state}`,
        { headers: { cookie, origin } },
      );
      const discovery = (await callbackRes.json()) as { discoveryId: string };

      // Executa connect com injeção de falha de limpeza no Redis
      const connectRes = await fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/social-accounts/connect`,
        {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({
            discoveryId: discovery.discoveryId,
            selectedAssets: [
              {
                platform: "FACEBOOK_PAGE",
                platformAccountId: "page_cleanup_fail",
              },
            ],
          }),
        },
      );

      // Resposta ao usuário continua sendo 200 (sucesso)
      expect(connectRes.status).toBe(200);

      // Confirma que no PostgreSQL a conta e a credencial foram gravadas
      const account = await migration.socialAccount.findFirst({
        where: { platformAccountId: "page_cleanup_fail" },
      });
      expect(account).not.toBeNull();
      expect(account?.status).toBe("ACTIVE");

      const cred = await migration.oAuthCredential.findUnique({
        where: { socialAccountId: account!.id },
      });
      expect(cred).not.toBeNull();

      // Confirma que o consumo foi registrado no PostgreSQL
      const consumption = await migration.oAuthDiscoveryConsumption.findUnique({
        where: { discoveryId: discovery.discoveryId },
      });
      expect(consumption).not.toBeNull();

      // Confirma que exatamente 1 registro de auditoria foi criado para a conexão
      const auditLogsBefore = await migration.auditLog.findMany({
        where: {
          action: "social_account.connected",
          organizationId: "org-a",
          entityId: account!.id,
        },
      });
      expect(auditLogsBefore).toHaveLength(1);

      // Confirma que o evento oauth_discovery_cleanup_failed foi registrado com metadados seguros e código estável
      const cleanupCalls = consoleErrorSpy.mock.calls
        .map((args: unknown[]) => args.map(String).join(" "))
        .filter((msg: string) =>
          msg.includes("oauth_discovery_cleanup_failed"),
        );
      expect(cleanupCalls.length).toBeGreaterThanOrEqual(1);

      for (const logLine of cleanupCalls) {
        const parsed = JSON.parse(logLine);
        expect(parsed.event).toBe("oauth_discovery_cleanup_failed");
        expect(parsed.code).toBe("REDIS_CLEANUP_FAILED");
        expect(parsed.discoveryId).toBe(discovery.discoveryId);
        expect(parsed.organizationId).toBe("org-a");
        expect(parsed.clientId).toBe("client-a");
        // Confirma que a mensagem bruta ou segredo fictício NÃO vazou nos logs
        expect(logLine).not.toContain(FAKE_SECRET);
        expect(parsed).not.toHaveProperty("error");
      }

      // Repetição com seleção idêntica preserva HTTP 200 e NÃO gera nova auditoria
      const retryRes = await fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/social-accounts/connect`,
        {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({
            discoveryId: discovery.discoveryId,
            selectedAssets: [
              {
                platform: "FACEBOOK_PAGE",
                platformAccountId: "page_cleanup_fail",
              },
            ],
          }),
        },
      );
      expect(retryRes.status).toBe(200);

      const auditLogsAfter = await migration.auditLog.findMany({
        where: {
          action: "social_account.connected",
          organizationId: "org-a",
          entityId: account!.id,
        },
      });
      expect(auditLogsAfter).toHaveLength(1);

      await redis.del(`meta:oauth:discovery:${discovery.discoveryId}`);
    } finally {
      consoleErrorSpy.mockRestore();
      await customApp.close();
    }
  });

  it("expiração do lock durante a operação e aquisição por outra requisição com liberação atômica condicionada ao proprietário e PostgreSQL impedindo duplicação", async () => {
    let accessStartedResolve: () => void;
    const accessStartedPromise = new Promise<void>((resolve) => {
      accessStartedResolve = resolve;
    });

    let continueAccessResolve: () => void;
    const continueAccessPromise = new Promise<void>((resolve) => {
      continueAccessResolve = resolve;
    });

    const customConfig = readConfig({
      ...process.env,
      META_APP_ID: "meta-test-app-id",
      META_APP_SECRET: "meta-test-app-secret",
      META_GRAPH_URL: metaMock.url,
      CREDENTIAL_MASTER_KEY: TEST_KEY_32.toString("hex"),
    });

    const customApp = await createApplication(customConfig, {
      socialAccountDependencies: {
        graphBaseUrl: metaMock.url,
        appId: "meta-test-app-id",
        appSecret: "meta-test-app-secret",
        masterKey: TEST_KEY_32,
        lockTtlSeconds: 1, // TTL curto de 1 segundo para teste
        onBeforeAccess: async () => {
          accessStartedResolve();
          await continueAccessPromise;
        },
      },
    });

    await customApp.app.listen(0, "127.0.0.1");
    const serverAddr = customApp.app.getHttpServer().address() as AddressInfo;
    const customBase = `http://127.0.0.1:${serverAddr.port}`;

    try {
      const cookie = await login("admin-a");

      const authRes = await fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/integrations/meta/authorize`,
        { headers: { cookie, origin } },
      );
      const { state } = (await authRes.json()) as { state: string };
      const stateRaw = await redis.get(`meta:oauth:state:${state}`);
      const { codeChallenge } = JSON.parse(stateRaw!);

      const code = `lock_expire_code_${randomUUID()}`;
      metaMock.registerCode(code, {
        codeChallenge,
        pages: [
          {
            id: "page_lock_expire",
            name: "Page Lock Expire Test",
            access_token: "mock_expire_token",
          },
        ],
      });

      const callbackRes = await fetch(
        `${customBase}/api/integrations/meta/callback?code=${code}&state=${state}`,
        { headers: { cookie, origin } },
      );
      const discovery = (await callbackRes.json()) as { discoveryId: string };
      const lockKey = `meta:oauth:discovery:lock:${discovery.discoveryId}`;

      // Inicia requisição 1 que adquire o lock de 1s e pausa no hook onBeforeAccess
      const req1Promise = fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/social-accounts/connect`,
        {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({
            discoveryId: discovery.discoveryId,
            selectedAssets: [
              {
                platform: "FACEBOOK_PAGE",
                platformAccountId: "page_lock_expire",
              },
            ],
          }),
        },
      );

      // Aguarda a requisição 1 adquirir o lock e entrar no hook
      await accessStartedPromise;

      // Confirma que a requisição 1 detém o lock
      const lock1 = await redis.get(lockKey);
      expect(lock1).not.toBeNull();

      // Aguarda 1100ms para o lock de 1s expirar por TTL
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const lockAfterExpiry = await redis.get(lockKey);
      expect(lockAfterExpiry).toBeNull();

      // Outra requisição / processo concorrente adquire o lock com seu próprio proprietário
      const owner2 = "competitor_owner_token_abc";
      const acquired2 = await redis.set(lockKey, owner2, "EX", 15, "NX");
      expect(acquired2).toBe("OK");

      // Libera a requisição 1 para continuar e chegar ao bloco finally
      continueAccessResolve!();
      const res1 = await req1Promise;
      expect(res1.status).toBe(200);

      // Prova 1: O finally da requisição 1 NÃO deletou o lock do owner2 devido à liberação atômica condicionada
      const lockAfterReq1Finally = await redis.get(lockKey);
      expect(lockAfterReq1Finally).toBe(owner2);

      // Prova 2: PostgreSQL impede efeitos duplicados
      // 2a. Verifica o estado inicial gravado pela requisição 1 no PostgreSQL
      const accountsCountInitial = await migration.socialAccount.count({
        where: { clientId: "client-a", platformAccountId: "page_lock_expire" },
      });
      expect(accountsCountInitial).toBe(1);

      const credsCountInitial = await migration.oAuthCredential.count({
        where: {
          socialAccount: {
            clientId: "client-a",
            platformAccountId: "page_lock_expire",
          },
        },
      });
      expect(credsCountInitial).toBe(1);

      const auditCountInitial = await migration.auditLog.count({
        where: {
          organizationId: "org-a",
          action: "social_account.connected",
        },
      });

      // Libera o lock concorrente para simular o término da espera do segundo processo
      await redis.del(lockKey);

      // 2b. Requisição subsequente para a mesma descoberta não duplica contas nem credenciais nem auditoria
      const req2SameRes = await fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/social-accounts/connect`,
        {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({
            discoveryId: discovery.discoveryId,
            selectedAssets: [
              {
                platform: "FACEBOOK_PAGE",
                platformAccountId: "page_lock_expire",
              },
            ],
          }),
        },
      );
      expect(req2SameRes.status).toBe(200);

      // PostgreSQL impediu efeitos duplicados: contas, credenciais e auditoria não aumentaram
      const accountsCountAfter = await migration.socialAccount.count({
        where: { clientId: "client-a", platformAccountId: "page_lock_expire" },
      });
      expect(accountsCountAfter).toBe(1);

      const credsCountAfter = await migration.oAuthCredential.count({
        where: {
          socialAccount: {
            clientId: "client-a",
            platformAccountId: "page_lock_expire",
          },
        },
      });
      expect(credsCountAfter).toBe(1);

      const auditCountAfter = await migration.auditLog.count({
        where: {
          organizationId: "org-a",
          action: "social_account.connected",
        },
      });
      expect(auditCountAfter).toBe(auditCountInitial);

      // 2c. Requisição com seleção diferente é bloqueada com 409 e não altera o banco
      const req3DiffRes = await fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/social-accounts/connect`,
        {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({
            discoveryId: discovery.discoveryId,
            selectedAssets: [
              {
                platform: "FACEBOOK_PAGE",
                platformAccountId: "invented_divergent_page",
              },
            ],
          }),
        },
      );
      expect(req3DiffRes.status).toBe(409);

      // 2d. O próprio schema do PostgreSQL rejeita tentativa concorrente direta de duplicar o consumo do discoveryId
      const adminUser = await migration.user.findFirst({
        where: { email: "admin-a@socialflow.test" },
      });
      expect(adminUser).not.toBeNull();

      await expect(
        migration.oAuthDiscoveryConsumption.create({
          data: {
            discoveryId: discovery.discoveryId,
            organizationId: "org-a",
            clientId: "client-a",
            userId: adminUser!.id,
            selectedAssets: [],
            connectedAccountIds: [],
          },
        }),
      ).rejects.toThrow();
    } finally {
      await customApp.close();
    }
  });

  async function waitForPostgresLockContention(
    expectedWaiterPid: number,
    expectedBlockerPid: number,
    timeoutMs = 5000,
  ): Promise<{ waiterPid: number; blockerPids: number[] }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await migration.$queryRaw<
        Array<{
          waiter_pid: number;
          blocker_pids: number[];
        }>
      >`
        SELECT
          l.pid as waiter_pid,
          pg_blocking_pids(l.pid) as blocker_pids
        FROM pg_locks l
        WHERE NOT l.granted
          AND l.pid = ${expectedWaiterPid}
      `;
      const matched = result.find(
        (r) =>
          r.waiter_pid === expectedWaiterPid &&
          Array.isArray(r.blocker_pids) &&
          r.blocker_pids.includes(expectedBlockerPid),
      );
      if (matched) {
        return {
          waiterPid: matched.waiter_pid,
          blockerPids: matched.blocker_pids,
        };
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `Timeout de ${timeoutMs}ms aguardando contenção de lock no PostgreSQL: waiter ${expectedWaiterPid} bloqueado por ${expectedBlockerPid}.`,
    );
  }

  it("concorrência real com sobreposição PostgreSQL e seleção idêntica: exatamente um consumo, sem 500 e sem auditorias duplicadas", async () => {
    let req1Pid = 0;
    let req2Pid = 0;
    let reqCount = 0;

    let req1InTxResolve: () => void;
    const req1InTxPromise = new Promise<void>((r) => {
      req1InTxResolve = r;
    });

    let continueReq1Resolve: () => void;
    const continueReq1Promise = new Promise<void>((r) => {
      continueReq1Resolve = r;
    });

    let req2StartedResolve: () => void;
    const req2StartedPromise = new Promise<void>((r) => {
      req2StartedResolve = r;
    });

    const customConfig = readConfig({
      ...process.env,
      META_APP_ID: "meta-test-app-id",
      META_APP_SECRET: "meta-test-app-secret",
      META_GRAPH_URL: metaMock.url,
      CREDENTIAL_MASTER_KEY: TEST_KEY_32.toString("hex"),
    });

    const customApp = await createApplication(customConfig, {
      socialAccountDependencies: {
        graphBaseUrl: metaMock.url,
        appId: "meta-test-app-id",
        appSecret: "meta-test-app-secret",
        masterKey: TEST_KEY_32,
        lockTtlSeconds: 1, // TTL de 1 segundo para o lock expirar durante a pausa da transação
        onTransactionStart: async (tx: Prisma.TransactionClient) => {
          reqCount++;
          const [res] = await tx.$queryRaw<
            [{ pid: number }]
          >`SELECT pg_backend_pid() as pid`;
          if (reqCount === 1) {
            req1Pid = res.pid;
          } else {
            req2Pid = res.pid;
            req2StartedResolve();
          }
        },
        onBeforeTransactionCommit: async () => {
          if (reqCount === 1) {
            req1InTxResolve();
            await continueReq1Promise;
          }
        },
      },
    });

    await customApp.app.listen(0, "127.0.0.1");
    const serverAddr = customApp.app.getHttpServer().address() as AddressInfo;
    const customBase = `http://127.0.0.1:${serverAddr.port}`;

    try {
      const cookie = await login("admin-a");

      const authRes = await fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/integrations/meta/authorize`,
        { headers: { cookie, origin } },
      );
      const { state } = (await authRes.json()) as { state: string };
      const stateRaw = await redis.get(`meta:oauth:state:${state}`);
      const { codeChallenge } = JSON.parse(stateRaw!);

      const code = `conc_same_code_${randomUUID()}`;
      metaMock.registerCode(code, {
        codeChallenge,
        pages: [
          {
            id: "page_conc_same",
            name: "Page Concurrency Same",
            access_token: "mock_conc_same_token",
          },
        ],
      });

      const callbackRes = await fetch(
        `${customBase}/api/integrations/meta/callback?code=${code}&state=${state}`,
        { headers: { cookie, origin } },
      );
      const discovery = (await callbackRes.json()) as { discoveryId: string };
      const lockKey = `meta:oauth:discovery:lock:${discovery.discoveryId}`;

      // Inicia requisição 1 que adquire o lock, grava no PostgreSQL e pausa em onBeforeTransactionCommit
      const req1Promise = fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/social-accounts/connect`,
        {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({
            discoveryId: discovery.discoveryId,
            selectedAssets: [
              {
                platform: "FACEBOOK_PAGE",
                platformAccountId: "page_conc_same",
              },
            ],
          }),
        },
      );

      // Aguarda req1 estar pausada dentro da transação PostgreSQL e comprova captura de req1Pid
      await req1InTxPromise;
      expect(req1Pid).toBeGreaterThan(0);

      // Aguarda 1100ms para expiração do lock no Redis
      await new Promise((r) => setTimeout(r, 1100));
      expect(await redis.get(lockKey)).toBeNull();

      // Inicia requisição 2 com seleção idêntica (sobreposição real no PostgreSQL)
      const req2Promise = fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/social-accounts/connect`,
        {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({
            discoveryId: discovery.discoveryId,
            selectedAssets: [
              {
                platform: "FACEBOOK_PAGE",
                platformAccountId: "page_conc_same",
              },
            ],
          }),
        },
      );

      // Aguarda req2 iniciar sua transação PostgreSQL e comprova captura de req2Pid
      await req2StartedPromise;
      expect(req2Pid).toBeGreaterThan(0);
      expect(req2Pid).not.toBe(req1Pid);

      // Sincronização verificável: comprova que a segunda requisição (req2Pid) está efetivamente aguardando
      // especificamente a liberação da primeira transação (req1Pid) no PostgreSQL
      try {
        const lockContention = await waitForPostgresLockContention(
          req2Pid,
          req1Pid,
        );
        expect(lockContention.waiterPid).toBe(req2Pid);
        expect(lockContention.blockerPids).toContain(req1Pid);
        console.info(
          `[SELECAO_IDENTICA] waiterPid=${lockContention.waiterPid}, blockerPids=[${lockContention.blockerPids.join(", ")}], req1Pid=${req1Pid}, req2Pid=${req2Pid}`,
        );
      } finally {
        // Libera a requisição 1 para commitar
        continueReq1Resolve!();
      }

      const [res1, res2] = await Promise.all([req1Promise, req2Promise]);

      // Ambas respondem sem erro 500/503 e com status HTTP válidos (200/200)
      expect([res1.status, res2.status]).toEqual([200, 200]);

      // Exatamente um consumo durável no PostgreSQL
      const consumptions = await migration.oAuthDiscoveryConsumption.findMany({
        where: { discoveryId: discovery.discoveryId },
      });
      expect(consumptions).toHaveLength(1);

      // Exatamente 1 conta criada
      const accounts = await migration.socialAccount.findMany({
        where: { platformAccountId: "page_conc_same", clientId: "client-a" },
      });
      expect(accounts).toHaveLength(1);

      // Exatamente 1 credencial criada
      const creds = await migration.oAuthCredential.findMany({
        where: { socialAccountId: accounts[0]!.id },
      });
      expect(creds).toHaveLength(1);

      // Ausência de auditorias duplicadas
      const auditLogs = await migration.auditLog.findMany({
        where: {
          organizationId: "org-a",
          action: "social_account.connected",
          entityId: accounts[0]!.id,
        },
      });
      expect(auditLogs).toHaveLength(1);

      await redis.del(`meta:oauth:discovery:${discovery.discoveryId}`);
    } finally {
      await customApp.close();
    }
  });

  it("concorrência real com sobreposição PostgreSQL e seleção divergente: perdedora sofre rollback completo, retorna 409 e não gera auditoria fantasma", async () => {
    let req1Pid = 0;
    let req2Pid = 0;
    let reqCount = 0;

    let req1InTxResolve: () => void;
    const req1InTxPromise = new Promise<void>((r) => {
      req1InTxResolve = r;
    });

    let continueReq1Resolve: () => void;
    const continueReq1Promise = new Promise<void>((r) => {
      continueReq1Resolve = r;
    });

    let req2StartedResolve: () => void;
    const req2StartedPromise = new Promise<void>((r) => {
      req2StartedResolve = r;
    });

    const customConfig = readConfig({
      ...process.env,
      META_APP_ID: "meta-test-app-id",
      META_APP_SECRET: "meta-test-app-secret",
      META_GRAPH_URL: metaMock.url,
      CREDENTIAL_MASTER_KEY: TEST_KEY_32.toString("hex"),
    });

    const customApp = await createApplication(customConfig, {
      socialAccountDependencies: {
        graphBaseUrl: metaMock.url,
        appId: "meta-test-app-id",
        appSecret: "meta-test-app-secret",
        masterKey: TEST_KEY_32,
        lockTtlSeconds: 1, // TTL curto
        onTransactionStart: async (tx: Prisma.TransactionClient) => {
          reqCount++;
          const [res] = await tx.$queryRaw<
            [{ pid: number }]
          >`SELECT pg_backend_pid() as pid`;
          if (reqCount === 1) {
            req1Pid = res.pid;
          } else {
            req2Pid = res.pid;
            req2StartedResolve();
          }
        },
        onBeforeTransactionCommit: async () => {
          if (reqCount === 1) {
            req1InTxResolve();
            await continueReq1Promise;
          }
        },
      },
    });

    await customApp.app.listen(0, "127.0.0.1");
    const serverAddr = customApp.app.getHttpServer().address() as AddressInfo;
    const customBase = `http://127.0.0.1:${serverAddr.port}`;

    try {
      const cookie = await login("admin-a");

      const authRes = await fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/integrations/meta/authorize`,
        { headers: { cookie, origin } },
      );
      const { state } = (await authRes.json()) as { state: string };
      const stateRaw = await redis.get(`meta:oauth:state:${state}`);
      const { codeChallenge } = JSON.parse(stateRaw!);

      const code = `conc_div_code_${randomUUID()}`;
      metaMock.registerCode(code, {
        codeChallenge,
        pages: [
          {
            id: "page_div_1",
            name: "Page Divergent 1",
            access_token: "mock_div_token_1",
          },
          {
            id: "page_div_2",
            name: "Page Divergent 2",
            access_token: "mock_div_token_2",
          },
        ],
      });

      const callbackRes = await fetch(
        `${customBase}/api/integrations/meta/callback?code=${code}&state=${state}`,
        { headers: { cookie, origin } },
      );
      const discovery = (await callbackRes.json()) as { discoveryId: string };
      const lockKey = `meta:oauth:discovery:lock:${discovery.discoveryId}`;

      // Inicia requisição 1 selecionando page_div_1
      const req1Promise = fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/social-accounts/connect`,
        {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({
            discoveryId: discovery.discoveryId,
            selectedAssets: [
              {
                platform: "FACEBOOK_PAGE",
                platformAccountId: "page_div_1",
              },
            ],
          }),
        },
      );

      // Aguarda req1 estar pausada dentro da transação PostgreSQL e comprova captura de req1Pid
      await req1InTxPromise;
      expect(req1Pid).toBeGreaterThan(0);

      // Aguarda 1100ms para expirar o lock de req1 no Redis
      await new Promise((r) => setTimeout(r, 1100));
      expect(await redis.get(lockKey)).toBeNull();

      // Inicia requisição 2 selecionando page_div_2 (seleção divergente, sobreposição no banco)
      const req2Promise = fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/social-accounts/connect`,
        {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({
            discoveryId: discovery.discoveryId,
            selectedAssets: [
              {
                platform: "FACEBOOK_PAGE",
                platformAccountId: "page_div_2",
              },
            ],
          }),
        },
      );

      // Aguarda req2 iniciar sua transação PostgreSQL e comprova captura de req2Pid
      await req2StartedPromise;
      expect(req2Pid).toBeGreaterThan(0);
      expect(req2Pid).not.toBe(req1Pid);

      // Sincronização verificável: comprova que a segunda requisição (req2Pid) está efetivamente aguardando
      // especificamente a liberação da primeira transação (req1Pid) no PostgreSQL
      try {
        const lockContention = await waitForPostgresLockContention(
          req2Pid,
          req1Pid,
        );
        expect(lockContention.waiterPid).toBe(req2Pid);
        expect(lockContention.blockerPids).toContain(req1Pid);
        console.info(
          `[SELECAO_DIVERGENTE] waiterPid=${lockContention.waiterPid}, blockerPids=[${lockContention.blockerPids.join(", ")}], req1Pid=${req1Pid}, req2Pid=${req2Pid}`,
        );
      } finally {
        // Libera req1 para commitar
        continueReq1Resolve!();
      }

      const [res1, res2] = await Promise.all([req1Promise, req2Promise]);

      // A vencedora retorna 200, a perdedora divergente retorna 409 (sem 500/503)
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(409);

      // Exatamente um consumo durável no PostgreSQL
      const consumptions = await migration.oAuthDiscoveryConsumption.findMany({
        where: { discoveryId: discovery.discoveryId },
      });
      expect(consumptions).toHaveLength(1);
      expect(consumptions[0]?.selectedAssets).toEqual([
        { platform: "FACEBOOK_PAGE", platformAccountId: "page_div_1" },
      ]);

      // Rollback completo da perdedora (page_div_2 não existe no PostgreSQL)
      const accountDiv2 = await migration.socialAccount.findFirst({
        where: { platformAccountId: "page_div_2", clientId: "client-a" },
      });
      expect(accountDiv2).toBeNull();

      // Nenhuma credencial para page_div_2
      const allCreds = await migration.oAuthCredential.findMany({
        where: {
          socialAccount: {
            clientId: "client-a",
            platformAccountId: "page_div_2",
          },
        },
      });
      expect(allCreds).toHaveLength(0);

      // Nenhuma auditoria para page_div_2 (sem auditoria fantasma)
      const div2Audits = await migration.auditLog.findMany({
        where: {
          organizationId: "org-a",
          action: "social_account.connected",
          entityId: "page_div_2",
        },
      });
      expect(div2Audits).toHaveLength(0);

      // Apenas a vencedora page_div_1 foi persistida
      const accountDiv1 = await migration.socialAccount.findFirst({
        where: { platformAccountId: "page_div_1", clientId: "client-a" },
      });
      expect(accountDiv1).not.toBeNull();

      const div1Audits = await migration.auditLog.findMany({
        where: {
          organizationId: "org-a",
          action: "social_account.connected",
          entityId: accountDiv1!.id,
        },
      });
      expect(div1Audits).toHaveLength(1);

      await redis.del(`meta:oauth:discovery:${discovery.discoveryId}`);
    } finally {
      await customApp.close();
    }
  });

  it("recuperação de P2002 rejeita vínculo incompatível: usuário diferente recebe 403 e não gera efeitos duplicados", async () => {
    let triggeredP2002 = false;

    const editorUser = await migration.user.findFirst({
      where: { email: "editor-a@socialflow.test" },
    });
    expect(editorUser).not.toBeNull();

    let targetDiscoveryId = "";

    const customConfig = readConfig({
      ...process.env,
      META_APP_ID: "meta-test-app-id",
      META_APP_SECRET: "meta-test-app-secret",
      META_GRAPH_URL: metaMock.url,
      CREDENTIAL_MASTER_KEY: TEST_KEY_32.toString("hex"),
    });

    const customApp = await createApplication(customConfig, {
      socialAccountDependencies: {
        graphBaseUrl: metaMock.url,
        appId: "meta-test-app-id",
        appSecret: "meta-test-app-secret",
        masterKey: TEST_KEY_32,
        onBeforeCreateConsumption: async () => {
          if (!triggeredP2002 && targetDiscoveryId) {
            triggeredP2002 = true;
            // Cria um consumo com vínculo incompatível (pertence ao editor-a)
            // antes da transação do admin-a inserir, provocando erro P2002 real no PostgreSQL
            await migration.oAuthDiscoveryConsumption.create({
              data: {
                discoveryId: targetDiscoveryId,
                organizationId: "org-a",
                clientId: "client-a",
                userId: editorUser!.id,
                selectedAssets: [
                  {
                    platform: "FACEBOOK_PAGE",
                    platformAccountId: "page_incompat_user",
                  },
                ],
                connectedAccountIds: [],
              },
            });
          }
        },
      },
    });

    await customApp.app.listen(0, "127.0.0.1");
    const serverAddr = customApp.app.getHttpServer().address() as AddressInfo;
    const customBase = `http://127.0.0.1:${serverAddr.port}`;

    try {
      const cookieAdmin = await login("admin-a");

      const authRes = await fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/integrations/meta/authorize`,
        { headers: { cookie: cookieAdmin, origin } },
      );
      const { state } = (await authRes.json()) as { state: string };
      const stateRaw = await redis.get(`meta:oauth:state:${state}`);
      const { codeChallenge } = JSON.parse(stateRaw!);

      const code = `incompat_p2002_code_${randomUUID()}`;
      metaMock.registerCode(code, {
        codeChallenge,
        pages: [
          {
            id: "page_incompat_user",
            name: "Page Incompat User",
            access_token: "mock_incompat_token",
          },
        ],
      });

      const callbackRes = await fetch(
        `${customBase}/api/integrations/meta/callback?code=${code}&state=${state}`,
        { headers: { cookie: cookieAdmin, origin } },
      );
      const discovery = (await callbackRes.json()) as { discoveryId: string };
      targetDiscoveryId = discovery.discoveryId;

      // Executa connect com admin-a.
      // O hook onBeforeCreateConsumption cria previamente o consumo com userId = editor-a.
      // A transação do admin-a falha com P2002, aciona o bloco catch de recuperação,
      // e resolveExistingConsumption rejeita com 403 por manipulação de escopo entre usuários.
      const connectRes = await fetch(
        `${customBase}/api/organizations/org-a/clients/client-a/social-accounts/connect`,
        {
          method: "POST",
          headers: {
            cookie: cookieAdmin,
            origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            discoveryId: discovery.discoveryId,
            selectedAssets: [
              {
                platform: "FACEBOOK_PAGE",
                platformAccountId: "page_incompat_user",
              },
            ],
          }),
        },
      );

      expect(triggeredP2002).toBe(true);
      expect(connectRes.status).toBe(403);
      const body = (await connectRes.json()) as { message: string };
      expect(body.message).toContain(
        "Tentativa de manipulação de escopo entre tenants, usuários ou sessões detectada.",
      );

      // Rollback completo da transação que falhou: conta não foi persistida
      const account = await migration.socialAccount.findFirst({
        where: {
          platformAccountId: "page_incompat_user",
          clientId: "client-a",
        },
      });
      expect(account).toBeNull();

      // Nenhuma credencial criada
      const allCreds = await migration.oAuthCredential.findMany({
        where: {
          socialAccount: {
            clientId: "client-a",
            platformAccountId: "page_incompat_user",
          },
        },
      });
      expect(allCreds).toHaveLength(0);

      // Nenhuma auditoria para a conta rejeitada
      const auditLogs = await migration.auditLog.findMany({
        where: {
          organizationId: "org-a",
          action: "social_account.connected",
          entityId: "page_incompat_user",
        },
      });
      expect(auditLogs).toHaveLength(0);

      // Limpeza
      await migration.oAuthDiscoveryConsumption.deleteMany({
        where: { discoveryId: discovery.discoveryId },
      });
      await redis.del(`meta:oauth:discovery:${discovery.discoveryId}`);
    } finally {
      await customApp.close();
    }
  });

  it("comprova ausência de fallback e resposta segura de indisponibilidade quando Meta não está configurada, preservando demais módulos", async () => {
    // Config sem nenhuma credencial Meta ou master key
    const unconfiguredConfig = readConfig({
      ...process.env,
      META_APP_ID: "",
      META_APP_SECRET: "",
      CREDENTIAL_MASTER_KEY: "",
    });

    const unconfiguredApp = await createApplication(unconfiguredConfig);
    await unconfiguredApp.app.listen(0, "127.0.0.1");
    const addr = unconfiguredApp.app.getHttpServer().address() as AddressInfo;
    const testBase = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. Autenticação funciona normalmente
      const loginRes = await fetch(`${testBase}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
        },
        body: JSON.stringify({
          email: "admin-a@socialflow.test",
          password,
        }),
      });
      expect(loginRes.status).toBe(200);
      const cookie = loginRes.headers
        .getSetCookie()
        .map((s) => s.split(";")[0])
        .join("; ");

      // 2. Módulos não relacionados à Meta funcionam com sucesso (200)
      const meRes = await fetch(`${testBase}/api/me`, {
        headers: { cookie, origin },
      });
      expect(meRes.status).toBe(200);

      const clientsRes = await fetch(
        `${testBase}/api/organizations/org-a/clients`,
        { headers: { cookie, origin } },
      );
      expect(clientsRes.status).toBe(200);

      const brandsRes = await fetch(
        `${testBase}/api/organizations/org-a/clients/client-a/brands`,
        { headers: { cookie, origin } },
      );
      expect(brandsRes.status).toBe(200);

      const mediaRes = await fetch(
        `${testBase}/api/organizations/org-a/clients/client-a/media`,
        { headers: { cookie, origin } },
      );
      expect(mediaRes.status).toBe(200);

      const socialListRes = await fetch(
        `${testBase}/api/organizations/org-a/clients/client-a/social-accounts`,
        { headers: { cookie, origin } },
      );
      expect(socialListRes.status).toBe(200);

      // 3. Endpoints que exigem integração Meta respondem com erro seguro 503 antes de iniciar OAuth
      const authRes = await fetch(
        `${testBase}/api/organizations/org-a/clients/client-a/integrations/meta/authorize`,
        { headers: { cookie, origin } },
      );
      expect(authRes.status).toBe(503);
      const authBody = (await authRes.json()) as { message: string };
      expect(authBody.message).toBe("Serviço indisponível. Tente novamente.");

      // 4. Callback em modo API responde 503 com mensagem segura
      const callbackApiRes = await fetch(
        `${testBase}/api/integrations/meta/callback?code=mock_code&state=mock_state`,
        { headers: { cookie, origin } },
      );
      expect(callbackApiRes.status).toBe(503);
      const callbackApiBody = (await callbackApiRes.json()) as {
        message: string;
      };
      expect(callbackApiBody.message).toBe(
        "Serviço indisponível. Tente novamente.",
      );

      // 5. Callback em modo navegador redireciona de forma segura com meta_error=not_configured
      const callbackBrowserRes = await fetch(
        `${testBase}/api/integrations/meta/callback?code=mock_code&state=mock_state`,
        {
          headers: {
            cookie,
            origin,
            "sec-fetch-dest": "document",
          },
          redirect: "manual",
        },
      );
      expect(callbackBrowserRes.status).toBe(302);
      expect(callbackBrowserRes.headers.get("location")).toBe(
        "/?meta_error=not_configured",
      );
    } finally {
      await unconfiguredApp.close();
    }
  });

  it("comprova rejeição de chave de criptografia inválida no servidor com erro 503", async () => {
    const invalidKeyApp = await createApplication(
      readConfig({
        ...process.env,
        META_APP_ID: "valid-app-id",
        META_APP_SECRET: "valid-app-secret",
        CREDENTIAL_MASTER_KEY: "0123456789abcdef".repeat(4), // valid format for config
      }),
      {
        socialAccountDependencies: {
          appId: "valid-app-id",
          appSecret: "valid-app-secret",
          masterKey: "chave_invalida_curta", // inválida para o módulo criptográfico (deve ter 32 bytes)
        },
      },
    );

    await invalidKeyApp.app.listen(0, "127.0.0.1");
    const addr = invalidKeyApp.app.getHttpServer().address() as AddressInfo;
    const testBase = `http://127.0.0.1:${addr.port}`;

    try {
      const loginRes = await fetch(`${testBase}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
        },
        body: JSON.stringify({
          email: "admin-a@socialflow.test",
          password,
        }),
      });
      expect(loginRes.status).toBe(200);
      const cookie = loginRes.headers
        .getSetCookie()
        .map((s) => s.split(";")[0])
        .join("; ");

      // Rejeição antes de iniciar OAuth
      const authRes = await fetch(
        `${testBase}/api/organizations/org-a/clients/client-a/integrations/meta/authorize`,
        { headers: { cookie, origin } },
      );
      expect(authRes.status).toBe(503);
      const authBody = (await authRes.json()) as { message: string };
      expect(authBody.message).toBe("Serviço indisponível. Tente novamente.");

      // Rejeição no callback
      const callbackRes = await fetch(
        `${testBase}/api/integrations/meta/callback?code=mock_code&state=mock_state`,
        { headers: { cookie, origin } },
      );
      expect(callbackRes.status).toBe(503);
      const callbackBody = (await callbackRes.json()) as { message: string };
      expect(callbackBody.message).toBe(
        "Serviço indisponível. Tente novamente.",
      );
    } finally {
      await invalidKeyApp.close();
    }
  });
});
