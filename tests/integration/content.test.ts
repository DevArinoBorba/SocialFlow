import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  assertRuntimeRole,
} from "../../packages/db/src/index.js";
import { Redis } from "ioredis";

const db = createDatabase(process.env.DATABASE_URL!);
const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);
const base = `http://127.0.0.1:${process.env.TEST_API_PORT ?? 53001}`;
const origin = process.env.APP_URL!;
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
const password = process.env.DEV_SEED_PASSWORD!;

async function request(
  path: string,
  cookie = "",
  method = "GET",
  data?: unknown,
  contentType = "application/json",
  requestOrigin = origin,
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

  return fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      origin: requestOrigin,
      ...(contentType ? { "content-type": contentType } : {}),
    },
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
  await db.$connect();
  expect((await request("/health/ready")).status).toBe(200);
});

beforeEach(async () => {
  await migration.rateLimit.deleteMany();
});

afterAll(async () => {
  redis.disconnect();
  await db.$disconnect();
  await migration.$disconnect();
});

describe("PostgreSQL runtime RLS, constraints and triggers for ContentBatch and Post", () => {
  it("enforces RLS and FORCE RLS on ContentBatch and Post with runtime role", async () => {
    await assertRuntimeRole(db);
    const rls = await migration.$queryRaw<
      {
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('ContentBatch', 'Post')
      ORDER BY relname ASC
    `;
    expect(rls.length).toBe(2);
    expect(rls.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(
      true,
    );

    const owners = await db.$queryRaw<
      { tablename: string; tableowner: string }[]
    >`
      SELECT tablename, tableowner FROM pg_tables
      WHERE tablename IN ('ContentBatch', 'Post')
    `;
    expect(owners.every((o) => o.tableowner !== "socialflow_runtime")).toBe(
      true,
    );
  });

  it("triggers protect_batch_scope and protect_post_scope prevent scope mutation", async () => {
    const batch = await migration.contentBatch.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        name: "Lote Teste Triggers",
        status: "PENDING",
      },
    });

    const post = await migration.post.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        batchId: batch.id,
        caption: "Caption Inicial",
        status: "DRAFT",
      },
    });

    // Tentativa de alterar clientId do batch via SQL direto com migration
    await expect(
      migration.$executeRaw`
        UPDATE "ContentBatch" SET "clientId" = 'client-b' WHERE id = ${batch.id}
      `,
    ).rejects.toThrow();

    // Tentativa de alterar organizationId do post via SQL direto com migration
    await expect(
      migration.$executeRaw`
        UPDATE "Post" SET "organizationId" = 'org-b' WHERE id = ${post.id}
      `,
    ).rejects.toThrow();

    // Tentativa de alterar batchId do post via SQL direto com migration
    await expect(
      migration.$executeRaw`
        UPDATE "Post" SET "batchId" = 'novo-batch-id' WHERE id = ${post.id}
      `,
    ).rejects.toThrow();
  });

  it("composite foreign keys prevent batch and brand cross-tenant assignment", async () => {
    const batchB = await migration.contentBatch.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        name: "Lote de B",
        status: "PENDING",
      },
    });

    // Tentar criar post no cliente A associando ao lote do cliente B deve falhar no banco
    await expect(
      migration.post.create({
        data: {
          organizationId: "org-a",
          clientId: "client-a",
          batchId: batchB.id,
          caption: "Post Invalido",
        },
      }),
    ).rejects.toThrow();
  });
});

describe("Content Batch and Post Lifecycle API Tests", () => {
  it("processes mixed batch of 80 valid rows and 20 invalid rows with atomic persistence and error report", async () => {
    const cookie = await login("editor-a");

    // 1. Criar o batch
    const createRes = await request(
      "/api/organizations/org-a/clients/client-a/batches",
      cookie,
      "POST",
      { name: "Lote de Campanha de Outubro" },
    );
    expect(createRes.status).toBe(201);
    const batch = (await createRes.json()) as { id: string; name: string };
    expect(batch.id).toBeDefined();

    // 2. Gerar CSV de 100 linhas (80 válidas e 20 inválidas)
    const lines = [
      "title,caption,hashtags,callToAction,firstComment,suggestedDate",
    ];
    for (let i = 1; i <= 80; i++) {
      lines.push(
        `"Post ${i}","Legenda válida número ${i} com texto claro.","#tag${i}","Saiba mais","Comentário ${i}","2026-11-${String(10 + (i % 15)).padStart(2, "0")}T10:00:00Z"`,
      );
    }
    for (let j = 1; j <= 20; j++) {
      if (j % 2 === 0) {
        // Caption vazia
        lines.push(`"Post Erro ${j}","","","","",""`);
      } else {
        // Data inválida
        lines.push(
          `"Post Erro ${j}","Legenda válida","","","","data-invalida"`,
        );
      }
    }
    const csvContent = lines.join("\n");

    // 3. Upload e importação do CSV
    const importRes = await request(
      `/api/organizations/org-a/clients/client-a/batches/${batch.id}/import`,
      cookie,
      "POST",
      csvContent,
      "text/csv",
    );
    expect(importRes.status).toBe(200);
    const importBody = (await importRes.json()) as {
      totalRows: number;
      validRows: number;
      invalidRows: number;
      errors: Array<{ row: number; column: string; message: string }>;
    };

    expect(importBody.totalRows).toBe(100);
    expect(importBody.validRows).toBe(80);
    expect(importBody.invalidRows).toBe(20);
    expect(importBody.errors.length).toBe(20);

    // 4. Checar persistência no banco
    const savedBatch = await migration.contentBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(savedBatch.status).toBe("COMPLETED");
    expect(savedBatch.totalRows).toBe(100);
    expect(savedBatch.validRows).toBe(80);
    expect(savedBatch.invalidRows).toBe(20);
    expect(Array.isArray(savedBatch.errorReport)).toBe(true);
    expect((savedBatch.errorReport as unknown[]).length).toBe(20);

    // 5. Checar que exatamente 80 posts foram criados em DRAFT vinculados ao batch
    const posts = await migration.post.findMany({
      where: { batchId: batch.id },
      orderBy: { createdAt: "asc" },
    });
    expect(posts.length).toBe(80);
    expect(posts.every((p) => p.status === "DRAFT")).toBe(true);
    expect(posts.every((p) => p.organizationId === "org-a")).toBe(true);
    expect(posts.every((p) => p.clientId === "client-a")).toBe(true);

    // 6. Auditoria transacional
    const auditLogs = await migration.auditLog.findMany({
      where: { entityId: batch.id },
      orderBy: { createdAt: "asc" },
    });
    expect(auditLogs.some((l) => l.action === "batch.created")).toBe(true);
    expect(auditLogs.some((l) => l.action === "batch.imported")).toBe(true);
  });

  it("prevents IDOR between clients and organizations", async () => {
    const cookieA = await login("editor-a");

    const batchB = await migration.contentBatch.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        name: "Lote de B",
        status: "COMPLETED",
      },
    });

    const postB = await migration.post.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        batchId: batchB.id,
        caption: "Post Secreto de B",
        status: "DRAFT",
      },
    });

    // 1. Tentar ler batch de B usando a URL do cliente A
    const resBatch = await request(
      `/api/organizations/org-a/clients/client-a/batches/${batchB.id}`,
      cookieA,
    );
    expect(resBatch.status).toBe(404);

    // 2. Tentar ler post de B usando a URL do cliente A
    const resPost = await request(
      `/api/organizations/org-a/clients/client-a/posts/${postB.id}`,
      cookieA,
    );
    expect(resPost.status).toBe(404);

    // 3. Tentar editar post de B via URL de A
    const resEdit = await request(
      `/api/organizations/org-a/clients/client-a/posts/${postB.id}`,
      cookieA,
      "PATCH",
      { caption: "Hacked" },
    );
    expect(resEdit.status).toBe(404);

    // 4. Tentar importar no batch de B via URL de A
    const resImport = await request(
      `/api/organizations/org-a/clients/client-a/batches/${batchB.id}/import`,
      cookieA,
      "POST",
      "caption\nPost",
      "text/csv",
    );
    expect(resImport.status).toBe(404);

    // 5. Tentar acessar com org-b na URL sendo usuário de org-a
    const resCrossOrg = await request(
      `/api/organizations/org-b/clients/client-b/batches`,
      cookieA,
    );
    expect(resCrossOrg.status).toBe(404);
  });

  it("enforces RBAC matrix across OWNER, ADMIN, EDITOR, APPROVER, and CLIENT_VIEWER", async () => {
    const ownerCookie = await login("owner-a");
    const adminCookie = await login("admin-a");
    const editorCookie = await login("editor-a");
    const approverCookie = await login("approver-a");
    const viewerCookie = await login("viewer-a");

    // 1. CLIENT_VIEWER: somente leitura (POST /batches -> 403)
    const viewerCreate = await request(
      "/api/organizations/org-a/clients/client-a/batches",
      viewerCookie,
      "POST",
      { name: "Lote Viewer" },
    );
    expect(viewerCreate.status).toBe(403);

    // 2. APPROVER: não cria batch nem post manual (403)
    const approverCreateBatch = await request(
      "/api/organizations/org-a/clients/client-a/batches",
      approverCookie,
      "POST",
      { name: "Lote Approver" },
    );
    expect(approverCreateBatch.status).toBe(403);

    const approverCreatePost = await request(
      "/api/organizations/org-a/clients/client-a/posts",
      approverCookie,
      "POST",
      { caption: "Post Approver" },
    );
    expect(approverCreatePost.status).toBe(403);

    // 3. EDITOR: cria post manual (201)
    const editorCreatePost = await request(
      "/api/organizations/org-a/clients/client-a/posts",
      editorCookie,
      "POST",
      { caption: "Post criado pelo editor" },
    );
    expect(editorCreatePost.status).toBe(201);
    const post = (await editorCreatePost.json()) as {
      id: string;
      status: string;
    };
    expect(post.status).toBe("DRAFT");

    // 4. EDITOR tenta aprovar direto (403)
    const editorApprove = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/status`,
      editorCookie,
      "PATCH",
      { status: "APPROVED" },
    );
    expect(editorApprove.status).toBe(403);

    // 5. EDITOR submete para revisão (DRAFT -> IN_REVIEW) (200)
    const editorSubmit = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/status`,
      editorCookie,
      "PATCH",
      { status: "IN_REVIEW" },
    );
    expect(editorSubmit.status).toBe(200);

    // 6. EDITOR não pode editar post em IN_REVIEW (403)
    const editorEditInReview = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}`,
      editorCookie,
      "PATCH",
      { caption: "Tentativa de edição em revisão" },
    );
    expect(editorEditInReview.status).toBe(403);

    // 7. APPROVER tenta rejeitar SEM motivo (400)
    const rejectNoReason = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/status`,
      approverCookie,
      "PATCH",
      { status: "REJECTED" },
    );
    expect(rejectNoReason.status).toBe(400);

    // 8. APPROVER rejeita com motivo (200)
    const rejectWithReason = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/status`,
      approverCookie,
      "PATCH",
      { status: "REJECTED", rejectionReason: "Ajustar imagem e CTA" },
    );
    expect(rejectWithReason.status).toBe(200);

    // 9. EDITOR pode editar post REJECTED e reenviar para revisão
    const editorEditRejected = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}`,
      editorCookie,
      "PATCH",
      { caption: "Post ajustado pelo editor após rejeição" },
    );
    expect(editorEditRejected.status).toBe(200);

    await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/status`,
      editorCookie,
      "PATCH",
      { status: "IN_REVIEW" },
    );

    // 10. APPROVER aprova post (IN_REVIEW -> APPROVED) (200)
    const approverApprove = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}/status`,
      approverCookie,
      "PATCH",
      { status: "APPROVED" },
    );
    expect(approverApprove.status).toBe(200);

    // 11. ADMIN e OWNER têm acesso completo e podem editar post mesmo aprovado
    const adminEdit = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}`,
      adminCookie,
      "PATCH",
      { caption: "Post ajustado pelo admin em produção" },
    );
    expect(adminEdit.status).toBe(200);

    const ownerEdit = await request(
      `/api/organizations/org-a/clients/client-a/posts/${post.id}`,
      ownerCookie,
      "PATCH",
      { caption: "Post final revisado pelo owner" },
    );
    expect(ownerEdit.status).toBe(200);
  });

  it("cuts access immediately when membership is revoked with session active", async () => {
    const cookie = await login("editor-a");

    // Requisição inicial funciona
    const okRes = await request(
      "/api/organizations/org-a/clients/client-a/posts",
      cookie,
    );
    expect(okRes.status).toBe(200);

    // Revogar membership temporariamente no banco
    await migration.membership.updateMany({
      where: { userId: "editor-a", organizationId: "org-a" },
      data: { active: false },
    });

    try {
      // Mesma sessão aberta agora é cortada imediatamente com 404 (sem vazar dados)
      const cutRes = await request(
        "/api/organizations/org-a/clients/client-a/posts",
        cookie,
      );
      expect(cutRes.status).toBe(404);
    } finally {
      // Restaurar membership
      await migration.membership.updateMany({
        where: { userId: "editor-a", organizationId: "org-a" },
        data: { active: true },
      });
    }
  });

  it("denies access when client or organization is inactive", async () => {
    const cookie = await login("admin-a");

    const client = await migration.client.create({
      data: {
        organizationId: "org-a",
        name: "Cliente Inativo Teste",
        slug: `cliente-inativo-${randomUUID().slice(0, 8)}`,
        active: false,
      },
    });

    const res = await request(
      `/api/organizations/org-a/clients/${client.id}/posts`,
      cookie,
    );
    expect(res.status).toBe(404);
  });
});
