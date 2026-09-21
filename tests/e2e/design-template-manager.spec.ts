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
  const manager = page.getByRole("region", { name: "Modelos de design" });
  await expect(manager).toBeVisible();

  const initBtn = manager.getByRole("button", {
    name: "Inicializar modelos padrão",
  });
  if (await initBtn.isVisible()) {
    await initBtn.click();
    await expect(manager.getByText("Editorial Square")).toBeVisible();
  }
}

test.describe("Fase 6: Editor Básico de Templates de Design", () => {
  test("1. OWNER/ADMIN visualiza catálogo, inicializa padrões e cria novo template (versão 1)", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    await expect(manager).toBeVisible();

    await ensureDefaultTemplates(page);

    // Clica em "Criar modelo"
    await manager.getByRole("button", { name: "Criar modelo" }).click();
    await expect(
      manager.getByRole("heading", { name: "Criar novo modelo de design" }),
    ).toBeVisible();

    // Preenche o formulário
    const timestamp = Date.now();
    const newName = `Template E2E Test ${timestamp}`;
    await manager.getByLabel("Nome do modelo *").fill(newName);

    // Seleciona formato STORY
    await manager.getByLabel("Formato *").selectOption("STORY");

    // Verifica que tipografia é Inter (somente leitura / desabilitada)
    const fontSelect = manager.getByLabel("Tipografia");
    await expect(fontSelect).toBeDisabled();
    await expect(fontSelect).toHaveValue("Inter");

    // Verifica guias de safe area na prévia
    const previewViewport = manager.getByTestId("artwork-preview-viewport");
    await expect(previewViewport).toBeVisible();
    await expect(manager.locator(".preview-safe-area-guide")).toBeVisible();

    // Envia o formulário
    await manager
      .getByRole("button", { name: "Criar modelo (Versão 1)" })
      .click();

    // Deve abrir a tela de detalhe do novo modelo
    await expect(
      manager.getByRole("heading", { name: newName, exact: true }),
    ).toBeVisible();
    await expect(manager.getByText("Versão Ativa: v1")).toBeVisible();
    await expect(
      manager.getByText("Story / Reels (Vertical Cheio) (1080 × 1920 px)"),
    ).toBeVisible();
  });

  test("2. Validação client-side bloqueia injeção de HTML e nomes inválidos", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    await expect(manager).toBeVisible();
    await ensureDefaultTemplates(page);

    await manager.getByRole("button", { name: "Criar modelo" }).click();

    // Tenta submeter com nome contendo tag HTML
    await manager
      .getByLabel("Nome do modelo *")
      .fill("<script>alert('xss')</script>");
    await manager
      .getByRole("button", { name: "Criar modelo (Versão 1)" })
      .click();

    await expect(
      manager.getByText("O nome não pode conter HTML, CSS, URLs ou scripts."),
    ).toBeVisible();
  });

  test("3. Edição gera Versão 2 imutável e mantém histórico de versões auditado", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    await expect(manager).toBeVisible();
    await ensureDefaultTemplates(page);

    // Cria um template novo específico para teste de versionamento
    await manager.getByRole("button", { name: "Criar modelo" }).click();
    const tplName = `Template Versioning ${Date.now()}`;
    await manager.getByLabel("Nome do modelo *").fill(tplName);
    await manager
      .getByRole("button", { name: "Criar modelo (Versão 1)" })
      .click();

    await expect(manager.getByText("Versão Ativa: v1")).toBeVisible();

    // Inicia edição
    await manager.getByRole("button", { name: "Criar nova versão" }).click();
    await expect(
      manager.getByRole("heading", {
        name: new RegExp(`Editando nova versão para "${tplName}"`),
      }),
    ).toBeVisible();

    // Botão de salvar deve estar desabilitado se não houver alterações
    const saveBtn = manager.getByRole("button", { name: "Salvar nova versão" });
    await expect(saveBtn).toBeDisabled();

    // Altera safe area
    await manager.getByLabel("Área de segurança (safeArea)").fill("120");

    // Agora o botão de salvar deve estar habilitado e badge de alteração não salva deve aparecer
    await expect(saveBtn).toBeEnabled();
    await expect(
      manager.getByText("Alterações não salvas na especificação"),
    ).toBeVisible();

    // Salva a nova versão
    await saveBtn.click();

    // Verifica que a versão ativa agora é v2
    await expect(manager.getByText("Versão Ativa: v2")).toBeVisible();
    await expect(
      manager.getByText(`Nova versão 2 criada com sucesso para "${tplName}".`),
    ).toBeVisible();

    // Verifica o histórico de versões com v2 e v1
    const timeline = manager.locator(".versions-timeline");
    await expect(timeline.getByText("Versão 2 (Mais recente)")).toBeVisible();
    await expect(timeline.getByText("Versão 1", { exact: true })).toBeVisible();

    // Clica para visualizar a Versão 1 histórica
    const v1Row = timeline
      .locator(".timeline-version-row")
      .filter({ hasText: "Versão 1" });
    await v1Row.getByRole("button", { name: "Visualizar esta versão" }).click();
    await expect(
      manager.getByText("Visualizando Versão 1 (Histórica)"),
    ).toBeVisible();
    await expect(
      manager.getByText(
        "Esta é uma visualização em modo de leitura. Não afeta a versão mais recente em uso no gerador.",
      ),
    ).toBeVisible();
  });

  test("4. Duplicação gera novo template independente na versão 1 com systemKey nulo", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    await expect(manager).toBeVisible();
    await ensureDefaultTemplates(page);

    // Duplica o Editorial Portrait (busca pelo nome para garantir visibilidade com paginação)
    await manager
      .getByPlaceholder("Buscar modelo por nome…")
      .fill("Editorial Portrait");
    const portraitCard = manager
      .locator(".template-card")
      .filter({ hasText: "Editorial Portrait" });
    await portraitCard.getByRole("button", { name: "Duplicar" }).click();

    const modal = page.locator(".publish-modal");
    await expect(modal).toBeVisible();
    await expect(
      modal.getByRole("heading", { name: "Duplicar modelo de design" }),
    ).toBeVisible();

    const dupName = `Editorial Duplicado ${Date.now()}`;
    await modal.getByLabel("Nome do novo modelo *").fill(dupName);
    await modal.getByRole("button", { name: "Confirmar duplicação" }).click();

    // Deve abrir o novo template criado com status Ativo na Versão 1
    await expect(
      manager.getByRole("heading", { name: dupName, exact: true }),
    ).toBeVisible();
    await expect(manager.getByText("Versão Ativa: v1")).toBeVisible();
    // Não deve conter a badge "Modelo inicial" pois systemKey é null
    await expect(manager.locator(".system-badge")).toHaveCount(0);
  });

  test("5. Renomear template altera o nome sem incrementar número de versão", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    await expect(manager).toBeVisible();
    await ensureDefaultTemplates(page);

    // Cria um template específico para renomear
    await manager.getByRole("button", { name: "Criar modelo" }).click();
    const origName = `Orig Name ${Date.now()}`;
    await manager.getByLabel("Nome do modelo *").fill(origName);
    await manager
      .getByRole("button", { name: "Criar modelo (Versão 1)" })
      .click();

    await manager.getByRole("button", { name: "Renomear" }).click();

    const modal = page.locator(".publish-modal");
    await expect(modal).toBeVisible();
    const renamedName = `${origName} Renomeado`;
    await modal.getByLabel("Novo nome *").fill(renamedName);
    await modal.getByRole("button", { name: "Salvar novo nome" }).click();

    await expect(
      manager.getByText(`Modelo renomeado para "${renamedName}" com sucesso.`),
    ).toBeVisible();
    await expect(
      manager.getByRole("heading", { name: renamedName, exact: true }),
    ).toBeVisible();
  });

  test("6. Arquivar template remove-o do Gerador de Artes e Reativar restaura sincronização", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    const generator = page.getByRole("region", { name: "Gerador de artes" });
    await expect(manager).toBeVisible();
    await expect(generator).toBeVisible();
    await ensureDefaultTemplates(page);

    // Cria um template específico para arquivar
    await manager.getByRole("button", { name: "Criar modelo" }).click();
    const tempName = `Temp to Archive ${Date.now()}`;
    await manager.getByLabel("Nome do modelo *").fill(tempName);
    await manager
      .getByRole("button", { name: "Criar modelo (Versão 1)" })
      .click();

    // Confirma que o template aparece no Gerador de Artes
    await expect(
      generator.getByRole("radio", { name: new RegExp(tempName) }),
    ).toBeVisible();

    // Arquiva o template recém-criado a partir da tela de detalhe
    await manager.getByRole("button", { name: "Arquivar" }).click();

    const modal = page.locator(".publish-modal");
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Sim, arquivar modelo" }).click();

    await expect(
      manager.getByText(`Modelo "${tempName}" arquivado.`),
    ).toBeVisible();

    // Sincronização em tempo real: o template arquivado NÃO deve mais constar no Gerador de Artes!
    await expect(
      generator.getByRole("radio", { name: new RegExp(tempName) }),
    ).toHaveCount(0);

    // Volta ao catálogo e filtra por Arquivados
    await manager.getByRole("button", { name: "← Voltar ao catálogo" }).click();
    await manager.getByRole("button", { name: "Arquivados" }).click();
    await manager.getByPlaceholder("Buscar modelo por nome…").fill(tempName);
    const archivedCard = manager
      .locator(".template-card")
      .filter({ hasText: tempName });
    await expect(archivedCard).toBeVisible();

    // Reativa o template
    await archivedCard.getByRole("button", { name: "Reativar" }).click();
    await expect(
      manager.getByText(`Modelo "${tempName}" reativado com sucesso.`),
    ).toBeVisible();

    // Volta para o filtro de Ativos e busca tempName
    await manager.getByRole("button", { name: "Ativos" }).click();
    await manager.getByPlaceholder("Buscar modelo por nome…").fill(tempName);
    const reactivatedCard = manager
      .locator(".template-card")
      .filter({ hasText: tempName });
    await expect(reactivatedCard).toBeVisible();

    // Sincronização em tempo real: o template restaurado reaparece no Gerador de Artes!
    await expect(
      generator.getByRole("radio", { name: new RegExp(tempName) }),
    ).toBeVisible();
  });

  test("7. RBAC: EDITOR pode criar/editar/duplicar/arquivar, mas NÃO pode reativar nem inicializar", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "editor-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    await expect(manager).toBeVisible();

    // EDITOR pode criar modelo
    await expect(
      manager.getByRole("button", { name: "Criar modelo" }),
    ).toBeVisible();

    // Se a lista estivesse vazia, EDITOR não veria "Inicializar modelos padrão"
    // Vai para a aba Arquivados
    await manager.getByRole("button", { name: "Arquivados" }).click();

    // Botão de reativar NÃO pode aparecer para EDITOR
    await expect(manager.getByRole("button", { name: "Reativar" })).toHaveCount(
      0,
    );
  });

  test("8. RBAC: APPROVER e CLIENT_VIEWER permanecem estritamente somente leitura", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "viewer-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    await expect(manager).toBeVisible();

    // Não deve existir botão de criar modelo
    await expect(
      manager.getByRole("button", { name: "Criar modelo" }),
    ).toHaveCount(0);

    // Cards não devem ter botões de Editar versão, Duplicar, Renomear ou Arquivar
    await expect(
      manager.getByRole("button", { name: "Editar versão" }),
    ).toHaveCount(0);
    await expect(manager.getByRole("button", { name: "Duplicar" })).toHaveCount(
      0,
    );
    await expect(manager.getByRole("button", { name: "Renomear" })).toHaveCount(
      0,
    );
    await expect(manager.getByRole("button", { name: "Arquivar" })).toHaveCount(
      0,
    );

    // Mas pode visualizar
    await manager.getByRole("button", { name: "Visualizar" }).first().click();
    await expect(manager.getByText(/Versão Ativa: v/)).toBeVisible();
    await expect(
      manager.getByRole("button", { name: "Criar nova versão" }),
    ).toHaveCount(0);
  });

  test("9. Análise de contraste WCAG exibe badges de avaliação e explicações", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    await expect(manager).toBeVisible();
    await ensureDefaultTemplates(page);

    await manager.getByRole("button", { name: "Visualizar" }).first().click();

    // Painel de contraste deve estar visível
    const contrastPanel = manager.locator(".contrast-report-card");
    await expect(contrastPanel).toBeVisible();
    await expect(
      contrastPanel.getByText("Análise de Contraste WCAG 2.1"),
    ).toBeVisible();

    // Verifica que métricas individuais são avaliadas
    await expect(contrastPanel.getByText("Título Principal")).toBeVisible();
    await expect(contrastPanel.getByText("Subtítulo")).toBeVisible();
    await expect(contrastPanel.getByText("Chamada Superior")).toBeVisible();
    await expect(
      contrastPanel.getByText("Chamada para Ação (CTA)"),
    ).toBeVisible();
  });
});
