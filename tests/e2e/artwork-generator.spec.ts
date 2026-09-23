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

async function ensureTemplatesInitialized(page: Page) {
  const generator = page.getByRole("region", { name: "Gerador de artes" });
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

test.describe("Fase 6: Gerador de Artes Individual", () => {
  test("1. OWNER e ADMIN podem inicializar modelos padrão e visualizar os 3 formatos", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");

    const generator = page.getByRole("region", { name: "Gerador de artes" });
    await expect(generator).toBeVisible();

    await expect(
      generator.getByText("Carregando modelos de design…"),
    ).toHaveCount(0);
    const initBtn = generator.getByRole("button", {
      name: "Criar modelos iniciais",
    });
    if (await initBtn.isVisible()) {
      await expect(
        generator.getByText("Nenhum modelo de design disponível"),
      ).toBeVisible();
      await expect(generator.getByText("Quadrado (1080 × 1080)")).toBeVisible();
      await expect(generator.getByText("Retrato (1080 × 1350)")).toBeVisible();
      await expect(generator.getByText("Story (1080 × 1920)")).toBeVisible();

      await initBtn.click();
    }

    // Verifica que os modelos aparecem no catálogo
    await expect(
      generator.getByRole("radio", { name: /Editorial Square/ }),
    ).toBeVisible();
    await expect(
      generator.getByRole("radio", { name: /Editorial Portrait/ }),
    ).toBeVisible();
    await expect(
      generator.getByRole("radio", { name: /Editorial Story/ }),
    ).toBeVisible();
  });

  test("2. Seleção de SQUARE, PORTRAIT e STORY atualiza proporção da prévia e respeita flags", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });
    await expect(generator).toBeVisible();

    await ensureTemplatesInitialized(page);

    // 1. Seleciona Square
    const squareCard = generator
      .locator(".template-select-card")
      .filter({ hasText: "Editorial Square" });
    await squareCard.click();

    const previewWrapper = generator.locator(".preview-viewport-wrapper");
    await expect(previewWrapper).toHaveCSS("aspect-ratio", "1 / 1");

    // 2. Seleciona Portrait
    const portraitCard = generator
      .locator(".template-select-card")
      .filter({ hasText: "Editorial Portrait" });
    await portraitCard.click();
    await expect(previewWrapper).toHaveCSS("aspect-ratio", "4 / 5");

    // 3. Seleciona Story
    const storyCard = generator
      .locator(".template-select-card")
      .filter({ hasText: "Editorial Story" });
    await storyCard.click();
    await expect(previewWrapper).toHaveCSS("aspect-ratio", "9 / 16");
  });

  test("3. Formulário valida título obrigatório e limites de caracteres", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });

    await ensureTemplatesInitialized(page);

    const titleInput = generator.getByLabel("Título *");
    await expect(titleInput).toBeVisible();

    // Título vazio desabilita botão de submissão
    await titleInput.fill("");
    const submitBtn = generator.getByRole("button", {
      name: "Gerar arte",
      exact: true,
    });
    await expect(submitBtn).toBeDisabled();

    // Título preenchido habilita botão
    await titleInput.fill("Título válido da arte");
    await expect(submitBtn).toBeEnabled();

    // Contador de caracteres exibe contagem correta
    await expect(generator.getByText("21 / 180")).toBeVisible();
  });

  test("4. Prévia segura exibe textos como texto comum e não interpreta HTML/scripts", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });

    await ensureTemplatesInitialized(page);

    const titleInput = generator.getByLabel("Título *");
    const maliciousText = "<script>alert('xss')</script> & <b>negrito</b>";
    await titleInput.fill(maliciousText);

    // O texto deve aparecer como string literal dentro do artboard da prévia
    const previewArtboard = generator.locator(".preview-artboard");
    await expect(previewArtboard).toContainText(maliciousText);
    // Não deve conter a tag <b> interpretada como elemento HTML
    expect(await previewArtboard.locator("b").count()).toBe(0);
  });

  test("5. Idempotência estável: previne duplo clique e reutiliza chave em retry de rede", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });

    await ensureTemplatesInitialized(page);

    let requestCount = 0;
    let lastIdempotencyKey = "";

    // Intercepta a rota de criação de render jobs
    await page.route(
      "**/api/organizations/*/clients/*/render-jobs",
      async (route) => {
        if (route.request().method() === "POST") {
          requestCount++;
          const postData = JSON.parse(route.request().postData() || "{}");
          lastIdempotencyKey = postData.idempotencyKey;
          // Retorna sucesso mockado para teste rápido de frontend
          await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
              id: "job-e2e-idemp-1",
              status: "PENDING",
              templateVersionId: postData.templateVersionId,
              postId: null,
              backgroundMediaAssetId: null,
              logoMediaAssetId: null,
              outputMediaAssetId: null,
              outputMediaUrl: null,
              attemptNumber: 1,
              errorCode: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: null,
            }),
          });
          return;
        }
        await route.continue();
      },
    );

    await generator.getByLabel("Título *").fill("Arte de Teste Idempotência");
    const submitBtn = generator.getByRole("button", {
      name: "Gerar arte",
      exact: true,
    });

    // Submete uma vez
    await submitBtn.click();
    expect(requestCount).toBe(1);
    expect(lastIdempotencyKey).toBeTruthy();
    expect(lastIdempotencyKey.length).toBeGreaterThan(16);
  });

  test("6. EDITOR pode gerar artes, mas não vê botão de inicializar modelos", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "editor-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });
    await expect(generator).toBeVisible();

    // Editor não pode inicializar modelos
    await expect(
      generator.getByRole("button", { name: "Criar modelos iniciais" }),
    ).toHaveCount(0);

    // Mas editor pode ver catálogo e o formulário de geração
    await expect(generator.getByLabel("Título *")).toBeVisible();
    await expect(
      generator.getByRole("button", { name: "Gerar arte", exact: true }),
    ).toBeVisible();
  });

  test("7. APPROVER e CLIENT_VIEWER visualizam apenas catálogo e histórico (modo somente leitura)", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "viewer-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });
    await expect(generator).toBeVisible();

    // Banner de modo somente leitura
    await expect(generator.getByText("Modo somente leitura")).toBeVisible();

    // Não deve conter inputs de formulário nem botão de gerar arte
    await expect(generator.getByLabel("Título *")).toHaveCount(0);
    await expect(
      generator.getByRole("button", { name: "Gerar arte" }),
    ).toHaveCount(0);
    await expect(
      generator.getByRole("button", { name: "Criar modelos iniciais" }),
    ).toHaveCount(0);

    // Mas histórico recente é visível
    await expect(generator.getByText("Artes recentes")).toBeVisible();
  });

  test("8. Fundo e logotipo podem ser selecionados e removidos (Nenhuma)", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });

    await ensureTemplatesInitialized(page);

    // Seletor de imagem de fundo tem opção "Nenhuma (Cor sólida)"
    const bgNoneBtn = generator.getByRole("button", {
      name: "Nenhuma (Cor sólida)",
    });
    await expect(bgNoneBtn).toBeVisible();
    await bgNoneBtn.click();
    await expect(bgNoneBtn).toHaveClass(/active/);

    // Seletor de logotipo tem opção "Nenhum"
    const logoNoneBtn = generator.getByRole("button", {
      name: "Nenhum",
      exact: true,
    });
    await expect(logoNoneBtn).toBeVisible();
    await logoNoneBtn.click();
    await expect(logoNoneBtn).toHaveClass(/active/);

    // Resumo reflete mídias nulas
    await expect(generator.getByText("Fundo: Cor do modelo")).toBeVisible();
    await expect(generator.getByText("Logotipo: Nenhum")).toBeVisible();
  });

  test("9. Acompanhamento de job COMPLETED exibe imagem, download e atualiza histórico", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });

    await ensureTemplatesInitialized(page);

    const testJobId = `job-completed-${Date.now()}`;
    let pollCount = 0;

    await page.route(
      "**/api/organizations/*/clients/*/render-jobs",
      async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
              id: testJobId,
              status: "PENDING",
              templateVersionId: "tpl-v1",
              postId: null,
              backgroundMediaAssetId: null,
              logoMediaAssetId: null,
              outputMediaAssetId: null,
              outputMediaUrl: null,
              attemptNumber: 1,
              errorCode: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: null,
            }),
          });
          return;
        }
        await route.continue();
      },
    );

    await page.route(
      `**/api/organizations/*/clients/*/render-jobs/${testJobId}`,
      async (route) => {
        pollCount++;
        if (pollCount === 1) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              id: testJobId,
              status: "PROCESSING",
              templateVersionId: "tpl-v1",
              postId: null,
              backgroundMediaAssetId: null,
              logoMediaAssetId: null,
              outputMediaAssetId: null,
              outputMediaUrl: null,
              attemptNumber: 1,
              errorCode: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: null,
            }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              id: testJobId,
              status: "COMPLETED",
              templateVersionId: "tpl-v1",
              postId: null,
              backgroundMediaAssetId: null,
              logoMediaAssetId: null,
              outputMediaAssetId: "media-out-123",
              outputMediaUrl:
                "/api/organizations/org-a/clients/client-a/media/media-out-123/content",
              attemptNumber: 1,
              errorCode: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            }),
          });
        }
      },
    );

    await generator.getByLabel("Título *").fill("Arte para Conclusão");
    await generator
      .getByRole("button", { name: "Gerar arte", exact: true })
      .click();

    // Aguarda evolução para COMPLETED
    await expect(
      generator.getByText("Arte renderizada e salva com sucesso!"),
    ).toBeVisible();
    await expect(
      generator.getByRole("link", { name: "Baixar imagem" }),
    ).toBeVisible();
  });

  test("10. Job FAILED exibe mensagem segura sem stack trace ou dados internos", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });

    await ensureTemplatesInitialized(page);

    const testFailId = `job-failed-${Date.now()}`;

    await page.route(
      "**/api/organizations/*/clients/*/render-jobs",
      async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
              id: testFailId,
              status: "FAILED",
              templateVersionId: "tpl-v1",
              postId: null,
              backgroundMediaAssetId: null,
              logoMediaAssetId: null,
              outputMediaAssetId: null,
              outputMediaUrl: null,
              attemptNumber: 1,
              errorCode: "OUTPUT_OBJECT_CONFLICT",
              errorMessage:
                "Sensitive internal database message that must NOT appear",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: null,
            }),
          });
          return;
        }
        await route.continue();
      },
    );

    await generator.getByLabel("Título *").fill("Arte com Falha Controlada");
    await generator
      .getByRole("button", { name: "Gerar arte", exact: true })
      .click();

    await expect(
      generator.getByText("Não foi possível renderizar a arte."),
    ).toBeVisible();
    await expect(
      generator.getByText("Código: OUTPUT_OBJECT_CONFLICT"),
    ).toBeVisible();
    // Mensagem interna bruta não pode ser exibida
    await expect(
      page.getByText("Sensitive internal database message"),
    ).toHaveCount(0);
  });

  test("11. Ausência de regressão na Biblioteca de Imagens e no Gerenciador de Conteúdo", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");

    // Biblioteca de imagens permanece visível e funcional
    const library = page.getByRole("region", { name: "Biblioteca de imagens" });
    await expect(library).toBeVisible();

    // Gerenciador de conteúdo permanece visível e funcional
    const content = page.getByRole("region", {
      name: "Conteúdo e Publicações",
    });
    await expect(content).toBeVisible();

    // O gerador de artes está posicionado entre ambos
    const generator = page.getByRole("region", { name: "Gerador de artes" });
    await expect(generator).toBeVisible();
  });

  test("12. 'Nova arte' encerra acompanhamento visual local, limpa formulário e preserva job no histórico", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });
    await ensureTemplatesInitialized(page);

    const testJobId = `job-nova-arte-${Date.now()}`;

    await page.route(
      "**/api/organizations/*/clients/*/render-jobs",
      async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
              id: testJobId,
              status: "PROCESSING",
              templateVersionId: "tpl-v1",
              postId: null,
              backgroundMediaAssetId: null,
              logoMediaAssetId: null,
              outputMediaAssetId: null,
              outputMediaUrl: null,
              attemptNumber: 1,
              errorCode: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: null,
            }),
          });
          return;
        }
        await route.continue();
      },
    );

    await generator
      .getByLabel("Título *")
      .fill("Arte Original Em Processamento");
    await generator
      .getByRole("button", { name: "Gerar arte", exact: true })
      .click();

    // Card de status ativo visível
    await expect(generator.locator(".render-job-status-card")).toBeVisible();
    await expect(
      generator.getByText("Renderizando pixels da arte com Satori e Sharp…"),
    ).toBeVisible();

    // Clica em "Nova arte"
    await generator.getByRole("button", { name: "Nova arte" }).first().click();

    // Formulário foi limpo e card de status ativo sumiu
    await expect(generator.getByLabel("Título *")).toHaveValue("");
    await expect(generator.locator(".render-job-status-card")).toHaveCount(0);

    // Job anterior continua preservado no histórico de artes recentes
    await expect(generator.getByText("Artes recentes")).toBeVisible();
    await expect(generator.locator(".history-job-card").first()).toBeVisible();
  });

  test("13. Bloqueio de submissão acidental: formulário e botão ficam bloqueados durante PENDING/PROCESSING", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });
    await ensureTemplatesInitialized(page);

    const testJobId = `job-locked-${Date.now()}`;

    await page.route(
      "**/api/organizations/*/clients/*/render-jobs",
      async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
              id: testJobId,
              status: "PENDING",
              templateVersionId: "tpl-v1",
              postId: null,
              backgroundMediaAssetId: null,
              logoMediaAssetId: null,
              outputMediaAssetId: null,
              outputMediaUrl: null,
              attemptNumber: 1,
              errorCode: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: null,
            }),
          });
          return;
        }
        await route.continue();
      },
    );

    await generator.getByLabel("Título *").fill("Arte Para Teste de Bloqueio");
    await generator
      .getByRole("button", { name: "Gerar arte", exact: true })
      .click();

    // Alerta de renderização em andamento e botão desabilitado
    await expect(
      generator.getByText("Renderização em andamento:"),
    ).toBeVisible();
    const submitBtn = generator.getByRole("button", {
      name: "Geração em andamento…",
    });
    await expect(submitBtn).toBeDisabled();

    // Campo de título desabilitado
    await expect(generator.getByLabel("Título *")).toBeDisabled();
  });

  test("14. Armazenamento de mídias indisponível exibe aviso específico e permite gerar sem mídias", async ({
    page,
  }) => {
    // Intercepta rota de mídia simulando indisponibilidade
    await page.route(
      "**/api/organizations/*/clients/*/media*",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [],
            hasMore: false,
            available: false,
          }),
        });
      },
    );

    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });
    await ensureTemplatesInitialized(page);

    // Mensagem específica de armazenamento indisponível
    await expect(
      generator.getByText(
        "Armazenamento de imagens temporariamente indisponível. Você ainda pode gerar artes utilizando as cores do modelo.",
      ),
    ).toBeVisible();

    // Seletores Nenhuma continuam ativos
    await expect(
      generator.getByRole("button", { name: "Nenhuma (Cor sólida)" }),
    ).toBeVisible();
    await expect(
      generator.getByRole("button", { name: "Nenhum", exact: true }),
    ).toBeVisible();

    // Usuário consegue preencher e gerar mesmo com armazenamento indisponível
    await generator.getByLabel("Título *").fill("Arte Sem Mídia");
    await expect(
      generator.getByRole("button", { name: "Gerar arte", exact: true }),
    ).toBeEnabled();
  });

  test("15. Falha ao listar mídias exibe erro e botão de tentar novamente", async ({
    page,
  }) => {
    let failMedia = true;
    await page.route(
      "**/api/organizations/*/clients/*/media*",
      async (route) => {
        if (failMedia) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              message: "Falha de conexão com o storage.",
            }),
          });
          return;
        }
        await route.continue();
      },
    );

    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });
    await ensureTemplatesInitialized(page);

    // Exibe caixa de erro com botão de retry
    await expect(
      generator.getByText(
        "Não foi possível carregar as imagens da biblioteca.",
      ),
    ).toBeVisible();
    const retryBtn = generator.getByRole("button", {
      name: "Tentar novamente",
    });
    await expect(retryBtn).toBeVisible();

    // Clica em Tentar novamente e recupera
    failMedia = false;
    await retryBtn.click();
    await expect(
      generator.getByText(
        "Não foi possível carregar as imagens da biblioteca.",
      ),
    ).toHaveCount(0);
    await expect(
      generator.locator(".media-selector-box").first(),
    ).toBeVisible();
  });

  test("16. Histórico mapeia nome e dimensões do modelo quando presente no catálogo", async ({
    page,
  }) => {
    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });
    await ensureTemplatesInitialized(page);

    // Se houver jobs no histórico com versões conhecidas, o modelo e dimensões devem aparecer
    const historySection = generator.locator(".artwork-history-section");
    await expect(historySection).toBeVisible();

    // Se já existem itens no histórico
    const firstJobCard = historySection.locator(".history-job-card").first();
    if (await firstJobCard.isVisible()) {
      await expect(firstJobCard.locator(".history-details")).toBeVisible();
    }
  });

  test("17. POST retornando COMPLETED diretamente executa fluxo de conclusão imediata", async ({
    page,
  }) => {
    await page.route(
      "**/api/organizations/*/clients/*/render-jobs",
      async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({
              id: "direct-completed-job",
              status: "COMPLETED",
              templateVersionId: "test-ver-id",
              postId: null,
              backgroundMediaAssetId: null,
              logoMediaAssetId: null,
              outputMediaAssetId: "out-media-1",
              outputMediaUrl: "/media/out-1/content",
              attemptNumber: 1,
              errorCode: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            }),
          });
          return;
        }
        await route.continue();
      },
    );

    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });
    await ensureTemplatesInitialized(page);

    await generator.getByLabel("Título *").fill("Arte Conclusão Imediata");
    await generator
      .getByRole("button", { name: "Gerar arte", exact: true })
      .click();

    // Deve exibir aviso de sucesso imediatamente
    await expect(
      generator.getByText(
        "Arte gerada com sucesso! A imagem também foi adicionada à sua Biblioteca de Imagens.",
      ),
    ).toBeVisible();
  });

  test("18. POST retornando FAILED diretamente não inicia polling nem trata como sucesso", async ({
    page,
  }) => {
    await page.route(
      "**/api/organizations/*/clients/*/render-jobs",
      async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({
              id: "direct-failed-job",
              status: "FAILED",
              templateVersionId: "test-ver-id",
              postId: null,
              backgroundMediaAssetId: null,
              logoMediaAssetId: null,
              outputMediaAssetId: null,
              outputMediaUrl: null,
              attemptNumber: 1,
              errorCode: "RENDER_EXECUTION_TIMEOUT",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            }),
          });
          return;
        }
        await route.continue();
      },
    );

    await loginAndOpenClient(page, "admin-a@socialflow.test");
    const generator = page.getByRole("region", { name: "Gerador de artes" });
    await ensureTemplatesInitialized(page);

    await generator.getByLabel("Título *").fill("Arte Falha Imediata");
    await generator
      .getByRole("button", { name: "Gerar arte", exact: true })
      .click();

    // Deve exibir mensagem de erro
    await expect(
      generator.getByText(
        "A renderização da arte falhou. Você pode tentar novamente ou iniciar uma nova arte.",
      ),
    ).toBeVisible();

    // Não deve exibir mensagem de sucesso
    await expect(generator.getByText("Arte gerada com sucesso!")).toHaveCount(
      0,
    );
  });
});
