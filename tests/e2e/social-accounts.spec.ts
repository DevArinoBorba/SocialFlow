import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../packages/db/src/index.js";
import {
  startMetaMockServer,
  type MetaMockServer,
} from "../helpers/meta-mock.js";

const db = createDatabase(process.env.MIGRATION_DATABASE_URL!);
let metaMock: MetaMockServer;

test.beforeAll(async () => {
  // Start Meta mock HTTP server listening on 0.0.0.0:54321
  // Accessible from host and from inside Docker container via host.docker.internal:54321
  metaMock = await startMetaMockServer(54321, "0.0.0.0");
});

test.afterAll(async () => {
  await metaMock.close();
  await db.$disconnect();
});

test.beforeEach(async () => {
  await db.rateLimit.deleteMany();
  await db.oAuthDiscoveryConsumption.deleteMany({});
  await db.oAuthCredential.deleteMany({});
  await db.publicationAttempt.deleteMany({});
  await db.socialAccount.deleteMany({});
});

test.describe("Conexão Meta, Seleção de Descobertas e Desconexão Segura", () => {
  test("fluxo completo: conectar Meta, seleção parcial de contas, recarga e desconexão com confirmação", async ({
    page,
  }) => {
    // Intercepta navegação para o diálogo OAuth da Meta
    await page.route("**/v21.0/dialog/oauth*", async (route) => {
      const url = new URL(route.request().url());
      const redirectUri = url.searchParams.get("redirect_uri")!;
      const state = url.searchParams.get("state")!;
      const codeChallenge = url.searchParams.get("code_challenge") ?? undefined;

      const code = `code_e2e_${randomUUID()}`;
      metaMock.registerCode(code, {
        codeChallenge,
        pages: [
          {
            id: "page_e2e_unselected_1",
            name: "Página Não Selecionada",
            access_token: "mock_token_unselected",
          },
          {
            id: "page_e2e_selected_2",
            name: "Página Café Central",
            access_token: "mock_token_page_selected",
            instagramBusinessAccount: {
              id: "ig_e2e_selected_2",
              username: "cafecentral_ig",
              name: "Café Central Instagram",
            },
          },
        ],
      });

      // Simula retorno do consentimento da Meta redirecionando para a URL fixa de callback
      await route.fulfill({
        status: 302,
        headers: {
          location: `${redirectUri}?code=${code}&state=${state}`,
        },
      });
    });

    // 1. Login como administrador
    await page.goto("/");
    await page.getByLabel("E-mail").fill("admin-a@socialflow.test");
    await page
      .getByLabel("Senha", { exact: true })
      .fill(process.env.DEV_SEED_PASSWORD!);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();

    await expect(
      page.getByRole("heading", { name: "Clientes", exact: true }),
    ).toBeVisible();

    // 2. Acessar o cliente Café Central
    await page.getByRole("button", { name: "Abrir cliente" }).first().click();
    await expect(
      page.getByRole("heading", { name: "Contas Sociais" }),
    ).toBeVisible();

    // 3. Verifica estado inicial sem contas conectadas e botão "Conectar Meta"
    await expect(
      page.getByRole("heading", { name: "Nenhuma conta social conectada" }),
    ).toBeVisible();
    const connectBtn = page.getByRole("button", {
      name: "Conectar Meta",
      exact: true,
    });
    await expect(connectBtn).toBeVisible();

    // 4. Inicia fluxo OAuth clicando em "Conectar Meta"
    await connectBtn.click();

    // 5. Após retorno pelo proxy e redirecionamento, a tela de seleção de descobertas é exibida
    await expect(
      page.getByRole("heading", { name: "Selecionar Contas para Conexão" }),
    ).toBeVisible();

    // Valida que a URL não contém tokens, códigos ou parâmetros criptográficos
    const currentUrl = page.url();
    expect(currentUrl).not.toContain("code=");
    expect(currentUrl).not.toContain("access_token");
    expect(currentUrl).not.toContain("state=");

    // 6. Regra estrita: sem seleção automática (nenhum checkbox marcado por padrão)
    const checkboxUnselected = page.getByLabel("Página Não Selecionada");
    const checkboxSelected = page.getByLabel("Página Café Central");
    const checkboxInstagram = page.getByLabel("Café Central Instagram");

    await expect(checkboxUnselected).toBeVisible();
    await expect(checkboxSelected).toBeVisible();
    await expect(checkboxInstagram).toBeVisible();

    expect(await checkboxUnselected.isChecked()).toBe(false);
    expect(await checkboxSelected.isChecked()).toBe(false);
    expect(await checkboxInstagram.isChecked()).toBe(false);

    // Botão de conexão desabilitado quando nada está selecionado
    const confirmBtn = page.getByRole("button", {
      name: /Conectar \d+ conta\(s\) selecionada\(s\)/,
    });
    await expect(confirmBtn).toBeDisabled();

    // 7. Seleção parcial: seleciona apenas a segunda página e o Instagram (deixa a primeira desmarcada)
    await checkboxSelected.check();
    await checkboxInstagram.check();

    expect(await checkboxUnselected.isChecked()).toBe(false);
    expect(await checkboxSelected.isChecked()).toBe(true);
    expect(await checkboxInstagram.isChecked()).toBe(true);

    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    // 8. Confirmação da conexão e exibição das contas conectadas
    await expect(
      page.getByText("2 conta(s) conectada(s) com sucesso!"),
    ).toBeVisible();

    // As contas selecionadas aparecem na grade
    await expect(
      page.getByRole("heading", { name: "Página Café Central" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Café Central Instagram" }),
    ).toBeVisible();
    await expect(page.getByText("@cafecentral_ig")).toBeVisible();

    // A conta não selecionada NÃO deve estar presente
    await expect(
      page.getByRole("heading", { name: "Página Não Selecionada" }),
    ).toHaveCount(0);

    // 9. Validação de recarga (reload): contas persistem e permanecem ativas
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Contas Sociais" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Página Café Central" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Café Central Instagram" }),
    ).toBeVisible();

    // 10. Desconexão com confirmação
    const disconnectButtons = page.getByRole("button", {
      name: "Desconectar",
      exact: true,
    });
    await expect(disconnectButtons).toHaveCount(2);

    // Clica em desconectar na primeira conta
    await disconnectButtons.first().click();

    // Modal de confirmação é exibido
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();
    await expect(
      modal.getByRole("heading", { name: "Confirmar desconexão" }),
    ).toBeVisible();

    // Testa cancelamento no modal
    await modal.getByRole("button", { name: "Cancelar" }).click();
    await expect(modal).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Página Café Central" }),
    ).toBeVisible();

    // Clica novamente e confirma desconexão
    await disconnectButtons.first().click();
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Confirmar desconexão" }).click();

    // Notificação de desconexão e remoção da conta
    await expect(page.getByText("desconectada com sucesso.")).toBeVisible();
  });

  test("trata cancelamento do consentimento na Meta com mensagem amigável", async ({
    page,
  }) => {
    await page.route("**/v21.0/dialog/oauth*", async (route) => {
      const url = new URL(route.request().url());
      const redirectUri = url.searchParams.get("redirect_uri")!;
      const state = url.searchParams.get("state")!;

      // Simula usuário cancelando consentimento no Facebook
      await route.fulfill({
        status: 302,
        headers: {
          location: `${redirectUri}?error=access_denied&error_code=200&error_description=Permissions+error&error_reason=user_denied&state=${state}`,
        },
      });
    });

    await page.goto("/");
    await page.getByLabel("E-mail").fill("admin-a@socialflow.test");
    await page
      .getByLabel("Senha", { exact: true })
      .fill(process.env.DEV_SEED_PASSWORD!);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();

    await page.getByRole("button", { name: "Abrir cliente" }).first().click();
    await page
      .getByRole("button", { name: "Conectar Meta", exact: true })
      .click();

    // Retorna para a tela com mensagem amigável de cancelamento
    const alert = page.locator(".error-box");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(
      "A conexão com a Meta foi cancelada pelo usuário.",
    );
  });

  test("CLIENT_VIEWER não visualiza botões de conexão ou desconexão e tem ações bloqueadas com 403", async ({
    page,
  }) => {
    // Pré-cria uma conta social ativa no banco para o cliente Café Central
    const account = await db.socialAccount.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        platform: "FACEBOOK_PAGE",
        platformAccountId: `fb_viewer_test_${Date.now()}`,
        name: "Página Visível para Viewer",
        status: "ACTIVE",
      },
    });

    try {
      await page.goto("/");
      await page.getByLabel("E-mail").fill("viewer-a@socialflow.test");
      await page
        .getByLabel("Senha", { exact: true })
        .fill(process.env.DEV_SEED_PASSWORD!);
      await page.getByRole("button", { name: "Entrar", exact: true }).click();

      await expect(
        page.getByRole("heading", { name: "Café Central", exact: true }),
      ).toBeVisible();

      // Abre o cliente para carregar a área de trabalho
      await page.getByRole("button", { name: "Abrir cliente" }).first().click();

      // Viewer consegue ver a conta conectada
      await expect(
        page.getByRole("heading", { name: "Página Visível para Viewer" }),
      ).toBeVisible();

      // Viewer NÃO deve ver o botão "Conectar Meta"
      await expect(
        page.getByRole("button", { name: "Conectar Meta" }),
      ).toHaveCount(0);

      // Viewer NÃO deve ver o botão "Desconectar"
      await expect(
        page.getByRole("button", { name: "Desconectar" }),
      ).toHaveCount(0);

      // Tentativa direta de chamar API de autorização via evaluate retorna 403
      const authStatus = await page.evaluate(async () => {
        const res = await fetch(
          "/api/organizations/org-a/clients/client-a/integrations/meta/authorize",
        );
        return res.status;
      });
      expect(authStatus).toBe(403);

      // Tentativa direta de chamar API de conexão via evaluate retorna 403
      const connectStatus = await page.evaluate(async () => {
        const res = await fetch(
          "/api/organizations/org-a/clients/client-a/social-accounts/connect",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              discoveryId: crypto.randomUUID(),
              selectedAssets: [
                {
                  platform: "FACEBOOK_PAGE",
                  platformAccountId: "fake-page-id",
                },
              ],
            }),
          },
        );
        return res.status;
      });
      expect(connectStatus).toBe(403);

      // Tentativa direta de desconectar via evaluate retorna 403
      const deleteStatus = await page.evaluate(async (accId) => {
        const res = await fetch(
          `/api/organizations/org-a/clients/client-a/social-accounts/${accId}`,
          { method: "DELETE" },
        );
        return res.status;
      }, account.id);
      expect(deleteStatus).toBe(403);
    } finally {
      await db.socialAccount.deleteMany({ where: { id: account.id } });
    }
  });
});
