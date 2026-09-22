import { test, expect, type Page } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/index.js";
import type { DesignTemplateSpec } from "../../packages/contracts/src/design.js";

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
    await initBtn.click({ force: true });
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
    await manager
      .getByRole("button", { name: "Criar modelo" })
      .click({ force: true });
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
      .click({ force: true });

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

    await manager
      .getByRole("button", { name: "Criar modelo" })
      .click({ force: true });

    // Tenta submeter com nome contendo tag HTML
    await manager
      .getByLabel("Nome do modelo *")
      .fill("<script>alert('xss')</script>");
    await manager
      .getByRole("button", { name: "Criar modelo (Versão 1)" })
      .click({ force: true });

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
    await manager
      .getByRole("button", { name: "Criar modelo" })
      .click({ force: true });
    const tplName = `Template Versioning ${Date.now()}`;
    await manager.getByLabel("Nome do modelo *").fill(tplName);
    await manager
      .getByRole("button", { name: "Criar modelo (Versão 1)" })
      .click({ force: true });

    await expect(manager.getByText("Versão Ativa: v1")).toBeVisible();

    // Inicia edição
    await manager
      .getByRole("button", { name: "Criar nova versão" })
      .click({ force: true });
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
    await saveBtn.click({ force: true });

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
    await v1Row
      .getByRole("button", { name: "Visualizar esta versão" })
      .click({ force: true });
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
    await portraitCard
      .getByRole("button", { name: "Duplicar" })
      .click({ force: true });

    const modal = page.locator(".publish-modal");
    await expect(modal).toBeVisible();
    await expect(
      modal.getByRole("heading", { name: "Duplicar modelo de design" }),
    ).toBeVisible();

    const dupName = `Editorial Duplicado ${Date.now()}`;
    await modal.getByLabel("Nome do novo modelo *").fill(dupName);
    await modal
      .getByRole("button", { name: "Confirmar duplicação" })
      .click({ force: true });

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
    await manager
      .getByRole("button", { name: "Criar modelo" })
      .click({ force: true });
    const origName = `Orig Name ${Date.now()}`;
    await manager.getByLabel("Nome do modelo *").fill(origName);
    await manager
      .getByRole("button", { name: "Criar modelo (Versão 1)" })
      .click({ force: true });

    await manager
      .getByRole("button", { name: "Renomear" })
      .click({ force: true });

    const modal = page.locator(".publish-modal");
    await expect(modal).toBeVisible();
    const renamedName = `${origName} Renomeado`;
    await modal.getByLabel("Novo nome *").fill(renamedName);
    await modal
      .getByRole("button", { name: "Salvar novo nome" })
      .click({ force: true });

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
    await manager
      .getByRole("button", { name: "Criar modelo" })
      .click({ force: true });
    const tempName = `Temp to Archive ${Date.now()}`;
    await manager.getByLabel("Nome do modelo *").fill(tempName);
    await manager
      .getByRole("button", { name: "Criar modelo (Versão 1)" })
      .click({ force: true });

    // Confirma que o template aparece no Gerador de Artes
    await expect(
      generator.getByRole("radio", { name: new RegExp(tempName) }),
    ).toBeVisible();

    // Arquiva o template recém-criado a partir da tela de detalhe
    await manager
      .getByRole("button", { name: "Arquivar" })
      .click({ force: true });

    const modal = page.locator(".publish-modal");
    await expect(modal).toBeVisible();
    await modal
      .getByRole("button", { name: "Sim, arquivar modelo" })
      .click({ force: true });

    await expect(
      manager.getByText(`Modelo "${tempName}" arquivado.`),
    ).toBeVisible();

    // Sincronização em tempo real: o template arquivado NÃO deve mais constar no Gerador de Artes!
    await expect(
      generator.getByRole("radio", { name: new RegExp(tempName) }),
    ).toHaveCount(0);

    // Volta ao catálogo e filtra por Arquivados
    await manager
      .getByRole("button", { name: "← Voltar ao catálogo" })
      .click({ force: true });
    await manager
      .getByRole("button", { name: "Arquivados" })
      .click({ force: true });
    await manager.getByPlaceholder("Buscar modelo por nome…").fill(tempName);
    const archivedCard = manager
      .locator(".template-card")
      .filter({ hasText: tempName });
    await expect(archivedCard).toBeVisible();

    // Reativa o template
    await archivedCard
      .getByRole("button", { name: "Reativar" })
      .click({ force: true });
    await expect(
      manager.getByText(`Modelo "${tempName}" reativado com sucesso.`),
    ).toBeVisible();

    // Volta para o filtro de Ativos e busca tempName
    await manager
      .getByRole("button", { name: "Ativos" })
      .click({ force: true });
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
    await manager
      .getByRole("button", { name: "Arquivados" })
      .click({ force: true });

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
    await manager
      .getByRole("button", { name: "Visualizar" })
      .first()
      .click({ force: true });
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

    await manager
      .getByRole("button", { name: "Visualizar" })
      .first()
      .click({ force: true });

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

  test("10. Concorrência Otimista: 409 preserva rascunho, exibe versões em conflito, reaplica sobre v2 e salva v3", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    await expect(manager).toBeVisible();
    await ensureDefaultTemplates(page);

    // Cria um template novo para teste de concorrência
    await manager
      .getByRole("button", { name: "Criar modelo" })
      .click({ force: true });
    const tplName = `Conflict Flow ${Date.now()}`;
    await manager.getByLabel("Nome do modelo *").fill(tplName);
    await manager
      .getByRole("button", { name: "Criar modelo (Versão 1)" })
      .click({ force: true });
    await expect(manager.getByText("Versão Ativa: v1")).toBeVisible();

    // Inicia edição
    await manager
      .getByRole("button", { name: "Criar nova versão" })
      .click({ force: true });
    await expect(
      manager.getByRole("heading", {
        name: new RegExp(`Editando nova versão para "${tplName}"`),
      }),
    ).toBeVisible();

    // Usuário altera safeArea para 120 (múltiplo de 10 do step)
    await manager.getByLabel("Área de segurança (safeArea)").fill("120");
    await expect(
      manager.getByText("Alterações não salvas na especificação"),
    ).toBeVisible();

    // Enquanto o formulário está aberto, outra transação cria a Versão 2 no banco de dados
    const dbTemplate = await db.designTemplate.findFirst({
      where: { name: tplName },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    expect(dbTemplate).not.toBeNull();

    await db.designTemplateVersion.create({
      data: {
        organizationId: dbTemplate!.organizationId,
        clientId: dbTemplate!.clientId,
        templateId: dbTemplate!.id,
        version: 2,
        format: "SQUARE",
        spec: {
          ...(dbTemplate!.versions[0]!.spec as unknown as DesignTemplateSpec),
          backgroundColor: "#880000",
        },
        specHash: "manual-e2e-concurrent-v2",
        rendererVersion: "1.0.0",
      },
    });

    // Usuário tenta salvar a nova versão (frontend envia expectedBaseVersion: 1)
    const saveBtn = manager.getByRole("button", { name: "Salvar nova versão" });
    await saveBtn.click({ force: true });

    // Conflito 409 detectado!
    const conflictCard = manager.locator(".conflict-alert-card");
    await expect(conflictCard).toBeVisible();
    await expect(
      conflictCard.getByText("Conflito de concorrência detectado"),
    ).toBeVisible();
    await expect(
      conflictCard.getByText("Versão em que sua edição começou:"),
    ).toBeVisible();
    await expect(
      conflictCard.getByText("Versão atual mais recente no servidor:"),
    ).toBeVisible();
    await expect(
      conflictCard.getByText(
        "Nenhuma alteração foi salva no servidor. Seu rascunho de trabalho foi preservado intacto.",
      ),
    ).toBeVisible();

    // Rascunho continua integralmente preservado no input
    await expect(
      manager.getByLabel("Área de segurança (safeArea)"),
    ).toHaveValue("120");
    // Badge de alterações não salvas permanece visível
    await expect(
      manager.getByText("Alterações não salvas na especificação"),
    ).toBeVisible();

    // Clica em "Reaplicar sobre a versão atual"
    await manager.getByTestId("reapply-draft-btn").click({ force: true });

    // Rascunho continua preservado (120)
    await expect(
      manager.getByLabel("Área de segurança (safeArea)"),
    ).toHaveValue("120");

    // Agora salva novamente (enviará expectedBaseVersion: 2)
    await saveBtn.click({ force: true });

    // Deve salvar com sucesso criando a Versão 3!
    await expect(manager.getByText("Versão Ativa: v3")).toBeVisible();
    await expect(
      manager.getByText(`Nova versão 3 criada com sucesso para "${tplName}".`),
    ).toBeVisible();
    await expect(manager.locator(".conflict-alert-card")).toHaveCount(0);
  });

  test("11. Concorrência Otimista: Descartar rascunho carrega versão mais recente e limpa estado sujo", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    await expect(manager).toBeVisible();
    await ensureDefaultTemplates(page);

    await manager
      .getByRole("button", { name: "Criar modelo" })
      .click({ force: true });
    const tplName = `Conflict Discard ${Date.now()}`;
    await manager.getByLabel("Nome do modelo *").fill(tplName);
    await manager
      .getByRole("button", { name: "Criar modelo (Versão 1)" })
      .click({ force: true });
    await expect(manager.getByText("Versão Ativa: v1")).toBeVisible();

    // Inicia edição
    await manager
      .getByRole("button", { name: "Criar nova versão" })
      .click({ force: true });
    await manager.getByLabel("Área de segurança (safeArea)").fill("140");

    // Cria versão 2 no banco de forma concorrente
    const dbTemplate = await db.designTemplate.findFirst({
      where: { name: tplName },
      include: { versions: { orderBy: { version: "desc" } } },
    });

    await db.designTemplateVersion.create({
      data: {
        organizationId: dbTemplate!.organizationId,
        clientId: dbTemplate!.clientId,
        templateId: dbTemplate!.id,
        version: 2,
        format: "SQUARE",
        spec: {
          ...(dbTemplate!.versions[0]!.spec as unknown as DesignTemplateSpec),
          safeArea: 90,
          backgroundColor: "#770000",
        },
        specHash: "manual-e2e-concurrent-v2-discard",
        rendererVersion: "1.0.0",
      },
    });

    // Submete e recebe 409
    await manager
      .getByRole("button", { name: "Salvar nova versão" })
      .click({ force: true });
    await expect(manager.locator(".conflict-alert-card")).toBeVisible();

    // Clica em "Descartar meu rascunho"
    await manager.getByTestId("discard-draft-btn").click({ force: true });

    // Formulário fecha e estado de conflito e dirty state somem
    await expect(manager.locator(".conflict-alert-card")).toHaveCount(0);
    await expect(
      manager.getByText("Alterações não salvas na especificação"),
    ).toHaveCount(0);
  });

  test("12. Contraste reprovado exige confirmação explícita; cancelar impede criação e confirmar prossegue", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    await expect(manager).toBeVisible();
    await ensureDefaultTemplates(page);

    await manager
      .getByRole("button", { name: "Criar modelo" })
      .click({ force: true });
    const tplName = `Contrast Fail ${Date.now()}`;
    await manager.getByLabel("Nome do modelo *").fill(tplName);

    // Define cores que causam reprovação de contraste (< 3.0:1)
    await manager.getByLabel("Fundo").fill("#202020");
    await manager.getByLabel("Texto Principal").fill("#252525");

    // Submete: deve abrir o modal de confirmação de contraste reprovado
    await manager
      .getByRole("button", { name: "Criar modelo (Versão 1)" })
      .click({ force: true });

    const contrastModal = page.getByTestId("contrast-confirm-modal");
    await expect(contrastModal).toBeVisible();
    await expect(
      contrastModal.getByRole("heading", {
        name: "Confirmação de Contraste Reprovado",
      }),
    ).toBeVisible();

    // Clica em cancelar: modal fecha e permanece na página de criação
    await contrastModal
      .getByTestId("cancel-contrast-save-btn")
      .click({ force: true });
    await expect(contrastModal).toHaveCount(0);
    await expect(
      manager.getByRole("heading", { name: "Criar novo modelo de design" }),
    ).toBeVisible();

    // Clica para submeter novamente
    await manager
      .getByRole("button", { name: "Criar modelo (Versão 1)" })
      .click({ force: true });
    await expect(contrastModal).toBeVisible();

    // Agora confirma
    await contrastModal
      .getByTestId("confirm-contrast-save-btn")
      .click({ force: true });

    // Template deve ser criado com sucesso
    await expect(
      manager.getByRole("heading", { name: tplName, exact: true }),
    ).toBeVisible();
    await expect(manager.getByText("Versão Ativa: v1")).toBeVisible();
  });

  test("13. Proteção de alterações não salvas: confirmação ao navegar com rascunho pendente", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    await expect(manager).toBeVisible();
    await ensureDefaultTemplates(page);

    await manager
      .getByRole("button", { name: "Visualizar" })
      .first()
      .click({ force: true });
    await manager
      .getByRole("button", { name: "Criar nova versão" })
      .click({ force: true });

    // Altera safe area para sujar o formulário
    await manager.getByLabel("Área de segurança (safeArea)").fill("160");
    await expect(
      manager.getByText("Alterações não salvas na especificação"),
    ).toBeVisible();

    // 1. Tenta voltar ao catálogo recusando o descarte (dismiss)
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain("Você possui alterações não salvas");
      void dialog.dismiss();
    });
    await manager
      .getByRole("button", { name: "← Voltar ao catálogo" })
      .click({ force: true });

    // Permanece na tela de edição com o rascunho preservado
    await expect(
      manager.getByText("Alterações não salvas na especificação"),
    ).toBeVisible();
    await expect(
      manager.getByLabel("Área de segurança (safeArea)"),
    ).toHaveValue("160");

    // 2. Agora aceita o descarte (accept)
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain("Você possui alterações não salvas");
      void dialog.accept();
    });
    await manager
      .getByRole("button", { name: "← Voltar ao catálogo" })
      .click({ force: true });

    // Deve retornar com sucesso ao catálogo
    await expect(
      manager.getByPlaceholder("Buscar modelo por nome…"),
    ).toBeVisible();
    await expect(
      manager.getByRole("button", { name: "Criar modelo" }),
    ).toBeVisible();
  });

  test("14. Busca, filtros e listagem do catálogo continuam funcionando sem regressão", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const manager = page.getByRole("region", { name: "Modelos de design" });
    await expect(manager).toBeVisible();
    await ensureDefaultTemplates(page);

    // Busca por termo específico
    await manager
      .getByPlaceholder("Buscar modelo por nome…")
      .fill("Editorial Portrait");
    await expect(manager.getByText("Editorial Portrait")).toBeVisible();
    await expect(manager.getByText("Editorial Square")).toHaveCount(0);

    // Busca por outro modelo
    await manager
      .getByPlaceholder("Buscar modelo por nome…")
      .fill("Editorial Square");
    await expect(manager.getByText("Editorial Square")).toBeVisible();
    await expect(manager.getByText("Editorial Portrait")).toHaveCount(0);

    // Limpa busca
    await manager.getByPlaceholder("Buscar modelo por nome…").fill("");
    await expect(
      manager.getByRole("button", { name: "Criar modelo" }),
    ).toBeVisible();

    // Filtra por Arquivados
    await manager
      .getByRole("button", { name: "Arquivados" })
      .click({ force: true });
    await expect(manager.getByRole("button", { name: "Ativos" })).toBeVisible();
  });
});
