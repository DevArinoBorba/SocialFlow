import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  asActor,
  assertRuntimeRole,
  createCredentialCrypto,
  CryptoError,
} from "../../packages/db/src/index.js";

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
