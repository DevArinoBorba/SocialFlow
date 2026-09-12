import { test, expect } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/index.js";
const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);
test.beforeEach(async () => {
  await migration.rateLimit.deleteMany();
});
test.afterAll(async () => {
  await migration.$disconnect();
});
test("admin logs in, creates and sees a client using keyboard", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("admin-a@socialflow.test");
  await page
    .getByLabel("Senha", { exact: true })
    .fill(process.env.DEV_SEED_PASSWORD!);
  await page.getByLabel("Senha", { exact: true }).press("Enter");
  await expect(
    page.getByRole("heading", { name: "Clientes", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Novo cliente" }).click();
  const name = `Cliente E2E ${Date.now()}`;
  await page.getByLabel("Nome do cliente").fill(name);
  await page
    .getByLabel("Identificador", { exact: true })
    .fill(`e2e-${Date.now()}`);
  await page
    .getByRole("button", { name: "Criar cliente", exact: true })
    .click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/clients-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Entre na sua conta" }),
  ).toBeVisible();
});
test("viewer sees only assigned client and API rejects direct creation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("viewer-a@socialflow.test");
  await page
    .getByLabel("Senha", { exact: true })
    .fill(process.env.DEV_SEED_PASSWORD!);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Café Central", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Novo cliente" })).toHaveCount(
    0,
  );
  const status = await page.evaluate(
    async () =>
      (
        await fetch("/api/organizations/org-a/clients", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Forbidden", slug: "forbidden" }),
        })
      ).status,
  );
  expect(status).toBe(403);
});

test("invalid login displays visible error alert and supports keyboard submission", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("admin-a@socialflow.test");
  await page.getByLabel("Senha", { exact: true }).fill("wrong-password");
  await page.getByLabel("Senha", { exact: true }).press("Enter");
  const alert = page.locator("p.error");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Não foi possível entrar");
});

test("displays empty state when organization has no clients", async ({
  page,
}) => {
  const emptyOrgId = `org-empty-${Date.now()}`;
  await migration.organization.create({
    data: { id: emptyOrgId, name: "Agência Vazia Teste" },
  });
  await migration.membership.create({
    data: {
      userId: "admin-a",
      organizationId: emptyOrgId,
      role: "ADMIN",
    },
  });
  try {
    await page.goto("/");
    await page.getByLabel("E-mail").fill("admin-a@socialflow.test");
    await page
      .getByLabel("Senha", { exact: true })
      .fill(process.env.DEV_SEED_PASSWORD!);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Clientes", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Organização").selectOption(emptyOrgId);
    await expect(
      page.getByRole("heading", { name: "Nenhum cliente por aqui ainda" }),
    ).toBeVisible();
    await expect(
      page.getByText("Crie o primeiro cliente desta organização para começar."),
    ).toBeVisible();
  } finally {
    await migration.membership.deleteMany({
      where: { organizationId: emptyOrgId },
    });
    await migration.organization.deleteMany({
      where: { id: emptyOrgId },
    });
  }
});
