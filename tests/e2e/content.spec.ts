import { test, expect } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/index.js";

const db = createDatabase(process.env.MIGRATION_DATABASE_URL!);

test.beforeEach(async () => {
  await db.rateLimit.deleteMany();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test("admin creates a post, verifies persistence after reload, and submits for review", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("admin-a@socialflow.test");
  await page
    .getByLabel("Senha", { exact: true })
    .fill(process.env.DEV_SEED_PASSWORD!);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "Clientes", exact: true }),
  ).toBeVisible();

  // Abrir o cliente
  await page.getByRole("button", { name: "Abrir cliente" }).first().click();

  const contentSection = page.getByRole("region", {
    name: "Conteúdo e Publicações",
  });
  await expect(contentSection).toBeVisible();

  // Abrir formulário de novo post
  await contentSection
    .getByRole("button", { name: "Novo post", exact: true })
    .click();

  const title = `Campanha E2E ${Date.now()}`;
  const caption =
    "Texto da publicação E2E sobre inovação e impacto nas redes sociais.";
  const hashtags = "#inovacao #socialflow #teste";

  await contentSection.getByLabel("Título (opcional)").fill(title);
  await contentSection
    .getByLabel("Texto da publicação (legenda) *")
    .fill(caption);
  await contentSection.getByLabel("Hashtags (opcional)").fill(hashtags);

  await contentSection
    .getByRole("button", { name: "Salvar rascunho", exact: true })
    .click();

  // Encontrar o post criado
  const postCard = contentSection
    .locator("article.post-card")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });

  await expect(postCard).toBeVisible();
  await expect(postCard.getByText("Rascunho")).toBeVisible();
  await expect(postCard.getByText(caption)).toBeVisible();

  // Enviar para revisão
  await postCard
    .getByRole("button", { name: "Enviar para revisão", exact: true })
    .click();
  await expect(postCard.getByText("Em revisão")).toBeVisible();

  await page.screenshot({
    path: info.outputPath("post-in-review.png"),
    fullPage: true,
  });

  // Recarregar e validar persistência
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Clientes", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Abrir cliente" }).first().click();

  const reloadedSection = page.getByRole("region", {
    name: "Conteúdo e Publicações",
  });
  const reloadedPost = reloadedSection
    .locator("article.post-card")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });

  await expect(reloadedPost).toBeVisible();
  await expect(reloadedPost.getByText("Em revisão")).toBeVisible();
});

test("import batch CSV with mixed valid and invalid rows displays report and creates valid drafts", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("admin-a@socialflow.test");
  await page
    .getByLabel("Senha", { exact: true })
    .fill(process.env.DEV_SEED_PASSWORD!);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: "Abrir cliente" }).first().click();

  const contentSection = page.getByRole("region", {
    name: "Conteúdo e Publicações",
  });

  // Abrir importador de CSV
  await contentSection
    .getByRole("button", { name: "Importar CSV", exact: true })
    .click();

  const now = Date.now();
  const batchName = `Lote Automatizado ${now}`;
  const title1 = `Lote Post 1 ${now}`;
  const title2 = `Lote Post 2 ${now}`;
  await contentSection.getByLabel("Nome do lote").fill(batchName);

  const csvContent =
    `caption,title,hashtags\n` +
    `"Post importado 1 - Sucesso","${title1}","#sucesso"\n` +
    `"Post importado 2 - Sucesso","${title2}","#conteudo"\n` +
    `"","Linha Invalida Sem Caption","#erro"\n`;

  await contentSection.getByLabel("Arquivo CSV (.csv)").setInputFiles({
    name: "posts-lote.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csvContent, "utf8"),
  });

  await contentSection
    .getByRole("button", { name: "Iniciar importação", exact: true })
    .click();

  // Conferir relatório de importação
  await expect(
    contentSection.getByText(
      "Importação concluída: 2 post(s) importado(s) com sucesso. 1 erro(s) em 3 linha(s) analisada(s).",
    ),
  ).toBeVisible();

  // Tabela de erros
  const errorRegion = contentSection.getByRole("region", {
    name: "Erros de importação",
  });
  await expect(errorRegion).toBeVisible();
  await expect(errorRegion.getByText("caption", { exact: true })).toBeVisible();

  // Conferir que os posts válidos foram criados como rascunho
  const post1 = contentSection.locator("article.post-card").filter({
    has: page.getByRole("heading", { name: title1, exact: true }),
  });
  const post2 = contentSection.locator("article.post-card").filter({
    has: page.getByRole("heading", { name: title2, exact: true }),
  });

  await expect(post1).toBeVisible();
  await expect(post2).toBeVisible();
});

test("approver logs in and approves a post, while viewer has read-only access", async ({
  page,
}) => {
  // 1. Criar post e enviar para revisão como Admin
  await page.goto("/");
  await page.getByLabel("E-mail").fill("admin-a@socialflow.test");
  await page
    .getByLabel("Senha", { exact: true })
    .fill(process.env.DEV_SEED_PASSWORD!);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: "Abrir cliente" }).first().click();

  const contentAdmin = page.getByRole("region", {
    name: "Conteúdo e Publicações",
  });
  await contentAdmin.getByRole("button", { name: "Novo post" }).click();

  const title = `Para Aprovação ${Date.now()}`;
  await contentAdmin.getByLabel("Título (opcional)").fill(title);
  await contentAdmin
    .getByLabel("Texto da publicação (legenda) *")
    .fill("Post a ser revisado e aprovado.");
  await contentAdmin.getByRole("button", { name: "Salvar rascunho" }).click();

  const postCardAdmin = contentAdmin
    .locator("article.post-card")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await postCardAdmin
    .getByRole("button", { name: "Enviar para revisão" })
    .click();
  await expect(postCardAdmin.getByText("Em revisão")).toBeVisible();

  // Logout
  await page.getByRole("button", { name: "Sair" }).click();

  // 2. Login como Aprovador
  await page.getByLabel("E-mail").fill("approver-a@socialflow.test");
  await page
    .getByLabel("Senha", { exact: true })
    .fill(process.env.DEV_SEED_PASSWORD!);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.getByRole("button", { name: "Abrir cliente" }).first().click();

  const contentApprover = page.getByRole("region", {
    name: "Conteúdo e Publicações",
  });
  // Aprovador não tem botão de novo post
  await expect(
    contentApprover.getByRole("button", { name: "Novo post" }),
  ).toHaveCount(0);

  const postCardApprover = contentApprover
    .locator("article.post-card")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(postCardApprover).toBeVisible();

  // Aprovar o post
  await postCardApprover
    .getByRole("button", { name: "Aprovar publicação" })
    .click();
  await expect(postCardApprover.locator("span.badge-approved")).toBeVisible();

  // Valida presença do botão "Publicar agora…" para aprovador
  const publishBtn = postCardApprover.getByRole("button", {
    name: "Publicar agora…",
  });
  await expect(publishBtn).toBeVisible();

  // Clica para abrir o modal de confirmação de publicação
  await publishBtn.click();
  const modal = page.locator("div.publish-modal");
  await expect(modal).toBeVisible();
  await expect(
    modal.getByRole("heading", { name: "Publicação Manual na Meta" }),
  ).toBeVisible();
  await expect(modal.getByText("Atenção:")).toBeVisible();

  // Fecha o modal pelo botão cancelar
  await modal.getByRole("button", { name: "Cancelar" }).click();
  await expect(modal).toHaveCount(0);

  // Logout
  await page.getByRole("button", { name: "Sair" }).click();

  // 3. Login como Visualizador
  await page.getByLabel("E-mail").fill("viewer-a@socialflow.test");
  await page
    .getByLabel("Senha", { exact: true })
    .fill(process.env.DEV_SEED_PASSWORD!);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.getByRole("button", { name: "Abrir cliente" }).first().click();

  const contentViewer = page.getByRole("region", {
    name: "Conteúdo e Publicações",
  });
  await expect(contentViewer).toBeVisible();
  // Nenhuma ação de escrita ou workflow visível para visualizador
  await expect(
    contentViewer.getByRole("button", { name: "Novo post" }),
  ).toHaveCount(0);
  await expect(
    contentViewer.getByRole("button", { name: "Importar CSV" }),
  ).toHaveCount(0);
  await expect(
    contentViewer.getByRole("button", { name: "Aprovar publicação" }),
  ).toHaveCount(0);
  await expect(
    contentViewer.getByRole("button", { name: "Enviar para revisão" }),
  ).toHaveCount(0);
  await expect(
    contentViewer.getByRole("button", { name: "Publicar agora…" }),
  ).toHaveCount(0);

  // Post aprovado é legível
  const postCardViewer = contentViewer
    .locator("article.post-card")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(postCardViewer).toBeVisible();
  await expect(postCardViewer.locator("span.badge-approved")).toBeVisible();
});

test("publish button visibility strictly requires APPROVED status and canApprove role (OWNER, ADMIN, APPROVER), never EDITOR or CLIENT_VIEWER, and never non-APPROVED statuses", async ({
  page,
}) => {
  test.setTimeout(60000);
  const runId = Date.now();
  const approvedTitle = `Post Approved ${runId}`;
  const draftTitle = `Post Draft ${runId}`;
  const inReviewTitle = `Post In Review ${runId}`;
  const rejectedTitle = `Post Rejected ${runId}`;

  // Criar posts cobrindo todos os status
  const approvedPost = await db.post.create({
    data: {
      organizationId: "org-a",
      clientId: "client-a",
      title: approvedTitle,
      caption: "Legenda de post aprovado para teste de publicação.",
      status: "APPROVED",
    },
  });

  await db.post.createMany({
    data: [
      {
        organizationId: "org-a",
        clientId: "client-a",
        title: draftTitle,
        caption: "Legenda de rascunho.",
        status: "DRAFT",
      },
      {
        organizationId: "org-a",
        clientId: "client-a",
        title: inReviewTitle,
        caption: "Legenda em revisão.",
        status: "IN_REVIEW",
      },
      {
        organizationId: "org-a",
        clientId: "client-a",
        title: rejectedTitle,
        caption: "Legenda rejeitada.",
        rejectionReason: "Precisa de ajustes.",
        status: "REJECTED",
      },
    ],
  });

  async function loginAndNavigate(email: string) {
    await page.goto("/");
    const logoutBtn = page.getByRole("button", { name: "Sair" });
    if (await logoutBtn.isVisible().catch(() => false)) {
      await logoutBtn.click();
    }
    await expect(page.getByLabel("E-mail")).toBeVisible();
    await page.getByLabel("E-mail").fill(email);
    await page
      .getByLabel("Senha", { exact: true })
      .fill(process.env.DEV_SEED_PASSWORD!);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Clientes", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Abrir cliente" }).first().click();
    const region = page.getByRole("region", {
      name: "Conteúdo e Publicações",
    });
    await expect(region).toBeVisible();
    return region;
  }

  // 1. OWNER: vê o botão no post APPROVED, mas NUNCA em DRAFT, IN_REVIEW ou REJECTED
  {
    const region = await loginAndNavigate("owner-a@socialflow.test");
    const approvedCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: approvedTitle, exact: true }),
    });
    await expect(
      approvedCard.getByRole("button", { name: "Publicar agora…" }),
    ).toBeVisible();

    const draftCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: draftTitle, exact: true }),
    });
    await expect(
      draftCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);

    const inReviewCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: inReviewTitle, exact: true }),
    });
    await expect(
      inReviewCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);

    const rejectedCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: rejectedTitle, exact: true }),
    });
    await expect(
      rejectedCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);
  }

  // 2. ADMIN: vê o botão no post APPROVED, mas NUNCA em DRAFT, IN_REVIEW ou REJECTED
  {
    const region = await loginAndNavigate("admin-a@socialflow.test");
    const approvedCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: approvedTitle, exact: true }),
    });
    await expect(
      approvedCard.getByRole("button", { name: "Publicar agora…" }),
    ).toBeVisible();

    const draftCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: draftTitle, exact: true }),
    });
    await expect(
      draftCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);

    const inReviewCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: inReviewTitle, exact: true }),
    });
    await expect(
      inReviewCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);

    const rejectedCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: rejectedTitle, exact: true }),
    });
    await expect(
      rejectedCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);
  }

  // 3. APPROVER: vê o botão no post APPROVED, mas NUNCA em DRAFT, IN_REVIEW ou REJECTED
  {
    const region = await loginAndNavigate("approver-a@socialflow.test");
    const approvedCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: approvedTitle, exact: true }),
    });
    await expect(
      approvedCard.getByRole("button", { name: "Publicar agora…" }),
    ).toBeVisible();

    const draftCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: draftTitle, exact: true }),
    });
    await expect(
      draftCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);

    const inReviewCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: inReviewTitle, exact: true }),
    });
    await expect(
      inReviewCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);

    const rejectedCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: rejectedTitle, exact: true }),
    });
    await expect(
      rejectedCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);
  }

  // 4. EDITOR: NÃO vê o botão em post APPROVED (mesmo com canWrite=true), nem em nenhum outro
  {
    const region = await loginAndNavigate("editor-a@socialflow.test");
    // Confirma que canWrite está preservado para criação/edição
    await expect(
      region.getByRole("button", { name: "Novo post" }),
    ).toBeVisible();

    const approvedCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: approvedTitle, exact: true }),
    });
    await expect(
      approvedCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);

    const draftCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: draftTitle, exact: true }),
    });
    await expect(
      draftCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);

    const inReviewCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: inReviewTitle, exact: true }),
    });
    await expect(
      inReviewCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);

    const rejectedCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: rejectedTitle, exact: true }),
    });
    await expect(
      rejectedCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);

    // Confirma que tentativa direta de EDITOR no endpoint continua retornando 403
    const directRes = await page.request.post(
      `/api/organizations/org-a/clients/client-a/posts/${approvedPost.id}/publish`,
      {
        data: {
          socialAccountIds: ["00000000-0000-0000-0000-000000000000"],
          idempotencyKey: `e2e_editor_forbidden_${runId}`,
        },
      },
    );
    expect(directRes.status()).toBe(403);
  }

  // 5. CLIENT_VIEWER: NÃO vê o botão em post APPROVED nem em nenhum outro
  {
    const region = await loginAndNavigate("viewer-a@socialflow.test");
    const approvedCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: approvedTitle, exact: true }),
    });
    await expect(
      approvedCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);

    const draftCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: draftTitle, exact: true }),
    });
    await expect(
      draftCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);

    const inReviewCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: inReviewTitle, exact: true }),
    });
    await expect(
      inReviewCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);

    const rejectedCard = region.locator("article.post-card").filter({
      has: page.getByRole("heading", { name: rejectedTitle, exact: true }),
    });
    await expect(
      rejectedCard.getByRole("button", { name: "Publicar agora…" }),
    ).toHaveCount(0);
  }
});
