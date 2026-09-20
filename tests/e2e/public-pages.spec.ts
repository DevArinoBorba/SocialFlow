import { test, expect } from "@playwright/test";

test.describe("Páginas Públicas Institucionais (/privacy e /terms)", () => {
  test("acessa /privacy sem autenticação com conteúdo obrigatório e layout responsivo", async ({
    page,
  }) => {
    // 1. Acessa /privacy diretamente sem sessão
    const response = await page.goto("/privacy");
    expect(response?.status()).toBe(200);

    // 2. Título da página e cabeçalho
    await expect(page).toHaveTitle(/Política de Privacidade \| SocialFlow/);
    await expect(
      page.getByRole("heading", {
        name: "Política de Privacidade",
        exact: true,
      }),
    ).toBeVisible();

    // 3. Menções obrigatórias: SocialFlow e contato arinoborba@gmail.com
    await expect(
      page.getByText("SocialFlow", { exact: false }).first(),
    ).toBeVisible();
    const contactLinks = page.locator('a[href^="mailto:arinoborba@gmail.com"]');
    await expect(contactLinks.first()).toBeVisible();
    expect(await contactLinks.count()).toBeGreaterThanOrEqual(1);

    // 4. Seções explicativas: Coleta, Uso, Armazenamento/Criptografia
    await expect(
      page.getByRole("heading", { name: "3. Dados Coletados" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "5. Armazenamento Seguro e Criptografia",
      }),
    ).toBeVisible();
    await expect(page.getByText("AES-256-GCM")).toBeVisible();

    // 5. Integração opcional com Meta (Facebook e Instagram) sem auto-seleção
    await expect(
      page.getByRole("heading", {
        name: "4. Integração Opcional com a Meta (Facebook e Instagram)",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("totalmente opcional e voluntária", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("nenhuma conta vem pré-marcada", { exact: false }),
    ).toBeVisible();

    // 6. Instruções para solicitar exclusão de dados
    await expect(
      page.getByRole("heading", { name: "7. Exclusão e Retenção de Dados" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Opção 1: Exclusão Direta pelo SocialFlow",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Opção 2: Revogação pelo Facebook / Meta",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Opção 3: Solicitação Formal por E-mail",
      }),
    ).toBeVisible();

    // 7. Responsividade e acessibilidade: sem transbordamento horizontal
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    // 8. Link para Termos de Uso
    const termsLink = page.getByRole("link", { name: "Termos de Uso" }).first();
    await expect(termsLink).toBeVisible();
    await termsLink.click();
    await expect(page).toHaveURL(/\/terms/);
  });

  test("acessa /terms sem autenticação com conteúdo obrigatório e layout responsivo", async ({
    page,
  }) => {
    // 1. Acessa /terms diretamente sem sessão
    const response = await page.goto("/terms");
    expect(response?.status()).toBe(200);

    // 2. Título da página e cabeçalho
    await expect(page).toHaveTitle(/Termos de Uso \| SocialFlow/);
    await expect(
      page.getByRole("heading", {
        name: "Termos de Uso da Plataforma",
        exact: true,
      }),
    ).toBeVisible();

    // 3. Menções obrigatórias: SocialFlow e contato arinoborba@gmail.com
    await expect(
      page.getByText("SocialFlow", { exact: false }).first(),
    ).toBeVisible();
    const contactLinks = page.locator('a[href^="mailto:arinoborba@gmail.com"]');
    await expect(contactLinks.first()).toBeVisible();
    expect(await contactLinks.count()).toBeGreaterThanOrEqual(1);

    // 4. Seções principais dos Termos de Uso
    await expect(
      page.getByRole("heading", { name: "1. Aceitação dos Termos" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "2. Descrição dos Serviços" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "4. Integrações de Terceiros (Meta: Facebook e Instagram)",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "5. Responsabilidade pelo Conteúdo" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "6. Uso Aceitável e Condutas Proibidas",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "9. Limitação de Responsabilidade" }),
    ).toBeVisible();

    // 5. Responsividade e acessibilidade: sem transbordamento horizontal
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    // 6. Link para Política de Privacidade
    const privacyLink = page.getByRole("link", { name: "Privacidade" }).first();
    await expect(privacyLink).toBeVisible();
    await privacyLink.click();
    await expect(page).toHaveURL(/\/privacy/);
  });

  test("tela de login exibe links institucionais públicos para /privacy e /terms", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Entre na sua conta" }),
    ).toBeVisible();

    const privacyLink = page.getByRole("link", { name: "Privacidade" });
    const termsLink = page.getByRole("link", { name: "Termos de Uso" });

    await expect(privacyLink).toBeVisible();
    await expect(termsLink).toBeVisible();

    // Clica no link de privacidade e confirma navegação
    await privacyLink.click();
    await expect(page).toHaveURL(/\/privacy/);
    await expect(
      page.getByRole("heading", { name: "Política de Privacidade" }),
    ).toBeVisible();
  });
});
