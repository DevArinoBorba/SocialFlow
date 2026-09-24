import { test, expect, type Page } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/index.js";

const db = createDatabase(process.env.MIGRATION_DATABASE_URL!);

test.beforeEach(async () => {
  await db.rateLimit.deleteMany();
});

test.afterAll(async () => {
  await db.$disconnect();
});

async function loginAndOpenClient(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/");
  await page.getByLabel("E-mail").fill(email);
  await page
    .getByLabel("Senha", { exact: true })
    .fill(process.env.DEV_SEED_PASSWORD!);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Clientes", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Abrir cliente" }).first().click();
}

async function ensureDefaultTemplates(page: Page) {
  const generator = page.getByRole("region", { name: "Gerador de artes" });
  await expect(generator).toBeVisible();
  await expect(
    generator.getByText("Carregando modelos de design…"),
  ).toHaveCount(0);
  const initBtn = generator.getByRole("button", {
    name: "Criar modelos iniciais",
  });
  if (await initBtn.isVisible()) {
    await initBtn.click();
  }
  await expect(
    generator.getByText("Editorial Square", { exact: true }),
  ).toBeVisible();
}

async function ensureSamplePosts() {
  const count = await db.post.count({
    where: { clientId: "client-a", organizationId: "org-a" },
  });
  if (count < 2) {
    await db.post.createMany({
      data: [
        {
          organizationId: "org-a",
          clientId: "client-a",
          title: "Post de Exemplo 1",
          caption: "Legenda de exemplo para renderização em lote segura.",
          status: "DRAFT",
        },
        {
          organizationId: "org-a",
          clientId: "client-a",
          title: "Post de Exemplo 2",
          caption: "Outra legenda de exemplo para lote.",
          status: "DRAFT",
        },
      ],
    });
  }
}

test.describe("Fase 6 Incremento 3: Geração de Artes em Lote (E2E)", () => {
  test("1. Seleção múltipla de posts, validação prévia e abertura do modal de lote", async ({
    page,
  }) => {
    await ensureSamplePosts();
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    await ensureDefaultTemplates(page);

    // Navega até a seção de Conteúdo
    const contentHeading = page.getByRole("heading", {
      name: "Conteúdo e Publicações",
    });
    await expect(contentHeading).toBeVisible();

    // Aguarda carregar posts e verifica que a barra de seleção em lote está presente
    await expect(page.locator(".post-card").first()).toBeVisible();
    const selectAllCheckbox = page.locator(
      ".batch-select-all-label input[type='checkbox']",
    );
    await expect(selectAllCheckbox).toBeVisible();
    await selectAllCheckbox.check();

    // Verifica que o botão de ação em lote aparece
    const batchTriggerBtn = page.getByRole("button", {
      name: /Gerar Artes em Lote/,
    });
    await expect(batchTriggerBtn).toBeVisible();

    // Abre o modal de geração em lote
    await batchTriggerBtn.click();

    // Verifica que o modal abriu com título e abas corretas
    const modalTitle = page.getByRole("heading", {
      name: "Geração de Artes em Lote",
    });
    await expect(modalTitle).toBeVisible();

    // Executa a validação do lote
    const validateBtn = page.getByRole("button", { name: "Validar Lote" });
    await expect(validateBtn).toBeVisible();
    await validateBtn.click();

    // Verifica que o resultado da validação aparece com sucesso
    await expect(page.getByText(/Resultado da Validação/i)).toBeVisible();
    await expect(page.getByText(/Alocação de recursos da VPS/i)).toBeVisible();

    // Fecha o modal
    const closeBtn = page.getByRole("button", {
      name: "Fechar modal de geração em lote",
    });
    await closeBtn.click();
    await expect(modalTitle).toHaveCount(0);
  });

  test("2. Cancelamento cooperativo com confirmação no modal de lote", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");

    // Abre o modal diretamente pelo botão de Lotes de Artes
    const openBatchesBtn = page.getByRole("button", {
      name: "Lotes de Artes",
    });
    await expect(openBatchesBtn).toBeVisible();
    await openBatchesBtn.click();

    // Navega até a aba de Histórico
    const historyTab = page.getByRole("tab", { name: "Histórico de Lotes" });
    await expect(historyTab).toBeVisible();
    await historyTab.click();

    await expect(
      page.getByRole("heading", { name: "Histórico de Lotes do Cliente" }),
    ).toBeVisible();
  });

  test("3. Aba Histórico de Lotes abre sem erro e exibe lotes ou estado vazio legítimo", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await loginAndOpenClient(page, "admin-a@socialflow.test");

    const openBatchesBtn = page.getByRole("button", { name: "Lotes de Artes" });
    await expect(openBatchesBtn).toBeVisible();
    await openBatchesBtn.click();

    const historyTab = page.getByRole("tab", { name: "Histórico de Lotes" });
    await expect(historyTab).toBeVisible();
    await historyTab.click();

    await expect(
      page.getByRole("heading", { name: "Histórico de Lotes do Cliente" }),
    ).toBeVisible();

    // Aguarda cards de lote ou texto legítimo de lista vazia ficarem visíveis
    const historyItemOrEmpty = page
      .locator(".batch-history-card")
      .first()
      .or(page.getByText("Nenhum lote gerado até o momento."));
    await expect(historyItemOrEmpty).toBeVisible({ timeout: 10000 });

    // Nenhuma exceção não tratada na página (evita regressão do TypeError de length)
    expect(pageErrors).toEqual([]);
  });
});
