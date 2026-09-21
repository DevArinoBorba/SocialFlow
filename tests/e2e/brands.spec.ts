import { test, expect } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/index.js";

const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);

test.beforeEach(async () => {
  await migration.rateLimit.deleteMany();
  await migration.brand.deleteMany({
    where: {
      name: { startsWith: "Marca" },
    },
  });
});

test.afterAll(async () => {
  await migration.$disconnect();
});

test("admin logs in, opens client, creates and edits a brand", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("admin-a@socialflow.test");
  await page
    .getByLabel("Senha", { exact: true })
    .fill(process.env.DEV_SEED_PASSWORD!);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "Clientes", exact: true }),
  ).toBeVisible();

  // Open client
  await page.getByRole("button", { name: "Abrir cliente" }).first().click();

  await expect(
    page.getByRole("button", { name: "← Voltar para todos os clientes" }),
  ).toBeVisible();

  // Create brand
  await page.getByRole("button", { name: "Nova marca" }).click();

  const brandName = `Marca E2E ${Date.now()}`;
  const brandDesc =
    "Descrição detalhada da marca para teste E2E com texto longo demonstrando que a interface se adapta perfeitamente sem cortes ou rolagem horizontal.";
  const brandAudience =
    "Público jovem e adulto urbano, interessado em sustentabilidade, tecnologia e produtos artesanais de alta qualidade.";
  const brandTone =
    "Vibrante, autêntico, acolhedor, transparente e com forte apelo visual.";

  await page.getByLabel("Nome da marca *").fill(brandName);
  await page.getByLabel("Descrição").fill(brandDesc);
  await page.getByLabel("Público-alvo").fill(brandAudience);
  await page.getByLabel("Tom de voz").fill(brandTone);

  await page.getByRole("button", { name: "Criar marca", exact: true }).click();

  // Confirm creation
  await expect(
    page.getByRole("heading", { name: brandName, exact: true }),
  ).toBeVisible();
  await expect(page.getByText(brandDesc)).toBeVisible();
  await expect(page.getByText(brandAudience)).toBeVisible();
  await expect(page.getByText(brandTone)).toBeVisible();

  // Verify responsive columns of .brand-grid (1 column on mobile, 2 columns on desktop)
  const columnsCount = await page
    .locator(".brand-grid")
    .first()
    .evaluate((el) => {
      return window
        .getComputedStyle(el)
        .gridTemplateColumns.split(" ")
        .filter(Boolean).length;
    });
  if (test.info().project.name === "mobile") {
    expect(columnsCount).toBe(1);
  } else {
    expect(columnsCount).toBe(2);
  }

  // Edit brand
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `Editar marca: ${brandName}` }),
  ).toBeVisible();

  const updatedTone =
    "Sofisticado, elegante, preciso e acolhedor em todas as comunicações digitais.";
  await page.getByLabel("Tom de voz").fill(updatedTone);
  await page
    .getByRole("button", { name: "Salvar alterações", exact: true })
    .click();

  await expect(page.getByText(updatedTone)).toBeVisible();
  await expect(
    page.getByText(`Marca ${brandName} atualizada com sucesso.`),
  ).toBeVisible();

  // Ensure layout is responsive without horizontal overflow
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.screenshot({
    path: `test-results/brands-${test.info().project.name}.png`,
    fullPage: true,
  });

  // Navigate back to clients
  await page
    .getByRole("button", { name: "← Voltar para todos os clientes" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Clientes", exact: true }),
  ).toBeVisible();

  // Clean up created brand
  await migration.brand.deleteMany({ where: { name: brandName } });
});

test("admin creates, verifies persistence after reload, and edits brand with long continuous text at field limits", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("admin-a@socialflow.test");
  await page
    .getByLabel("Senha", { exact: true })
    .fill(process.env.DEV_SEED_PASSWORD!);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "Clientes", exact: true }),
  ).toBeVisible();

  // Open client
  await page.getByRole("button", { name: "Abrir cliente" }).first().click();
  await expect(
    page.getByRole("button", { name: "← Voltar para todos os clientes" }),
  ).toBeVisible();

  // Continuous text without spaces at exact field limits (A-1)
  const brandName = `Marca Longa E2E ${Date.now()}`;
  const longDesc = "D".repeat(2000);
  const longAudience = "A".repeat(1000);
  const longTone = "T".repeat(1000);

  // Create brand
  await page.getByRole("button", { name: "Nova marca" }).click();
  await page.getByLabel("Nome da marca *").fill(brandName);
  await page.getByLabel("Descrição").fill(longDesc);
  await page.getByLabel("Público-alvo").fill(longAudience);
  await page.getByLabel("Tom de voz").fill(longTone);
  await page.getByRole("button", { name: "Criar marca", exact: true }).click();

  try {
    // Confirm creation & visibility
    await expect(
      page.getByRole("heading", { name: brandName, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(longDesc)).toBeVisible();
    await expect(page.getByText(longAudience)).toBeVisible();
    await expect(page.getByText(longTone)).toBeVisible();

    // Verify responsive columns (1 column on mobile, 2 columns on desktop)
    const getColumns = async () =>
      page
        .locator(".brand-grid")
        .first()
        .evaluate(
          (el) =>
            window
              .getComputedStyle(el)
              .gridTemplateColumns.split(" ")
              .filter(Boolean).length,
        );

    const isMobile = test.info().project.name === "mobile";
    expect(await getColumns()).toBe(isMobile ? 1 : 2);

    // Verify no horizontal overflow and no overlapping content
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    const descBox = await page
      .locator(".brand-description")
      .first()
      .boundingBox();
    const gridBox = await page.locator(".brand-grid").first().boundingBox();
    expect(descBox).not.toBeNull();
    expect(gridBox).not.toBeNull();
    expect(descBox!.y + descBox!.height).toBeLessThanOrEqual(gridBox!.y + 4);

    // Verify database record has integral content
    const savedBrand = await migration.brand.findFirstOrThrow({
      where: { name: brandName },
    });
    expect(savedBrand.description).toBe(longDesc);
    expect(savedBrand.targetAudience).toBe(longAudience);
    expect(savedBrand.toneOfVoice).toBe(longTone);

    // Verify persistence after reload (reloads page, resetting React state, then re-opens client)
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Clientes", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Abrir cliente" }).first().click();
    await expect(
      page.getByRole("button", { name: "← Voltar para todos os clientes" }),
    ).toBeVisible();

    await expect(
      page.getByRole("heading", { name: brandName, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(longDesc)).toBeVisible();
    await expect(page.getByText(longAudience)).toBeVisible();
    await expect(page.getByText(longTone)).toBeVisible();
    expect(await getColumns()).toBe(isMobile ? 1 : 2);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    // Edit brand with new continuous text at limits
    await page.getByRole("button", { name: "Editar", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: `Editar marca: ${brandName}` }),
    ).toBeVisible();

    const updatedDesc = "E".repeat(2000);
    const updatedAudience = "B".repeat(1000);
    const updatedTone = "U".repeat(1000);

    await page.locator(`#edit-description-${savedBrand.id}`).fill(updatedDesc);
    await page
      .locator(`#edit-targetAudience-${savedBrand.id}`)
      .fill(updatedAudience);
    await page.locator(`#edit-toneOfVoice-${savedBrand.id}`).fill(updatedTone);
    await page
      .getByRole("button", { name: "Salvar alterações", exact: true })
      .click();

    await expect(
      page.getByText(`Marca ${brandName} atualizada com sucesso.`),
    ).toBeVisible();
    await expect(page.getByText(updatedDesc)).toBeVisible();
    await expect(page.getByText(updatedAudience)).toBeVisible();
    await expect(page.getByText(updatedTone)).toBeVisible();

    // Verify database has updated integral content
    const updatedDbBrand = await migration.brand.findUniqueOrThrow({
      where: { id: savedBrand.id },
    });
    expect(updatedDbBrand.description).toBe(updatedDesc);
    expect(updatedDbBrand.targetAudience).toBe(updatedAudience);
    expect(updatedDbBrand.toneOfVoice).toBe(updatedTone);

    // Verify persistence of edits after reload
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Clientes", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Abrir cliente" }).first().click();
    await expect(
      page.getByRole("button", { name: "← Voltar para todos os clientes" }),
    ).toBeVisible();

    await expect(
      page.getByRole("heading", { name: brandName, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(updatedDesc)).toBeVisible();
    await expect(page.getByText(updatedAudience)).toBeVisible();
    await expect(page.getByText(updatedTone)).toBeVisible();
    expect(await getColumns()).toBe(isMobile ? 1 : 2);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    // Save screenshot for visual inspection
    await page.screenshot({
      path: `test-results/brands-longtext-${test.info().project.name}.png`,
      fullPage: true,
    });
  } finally {
    await migration.brand.deleteMany({ where: { name: brandName } });
  }
});

test("viewer opens assigned client, sees brands in read-only mode without write actions", async ({
  page,
}) => {
  const brandName = `Marca Leitura ${Date.now()}`;
  const testBrand = await migration.brand.create({
    data: {
      organizationId: "org-a",
      clientId: "client-a",
      name: brandName,
      description: "Apenas leitura para viewer",
      targetAudience: "Consumidores finais",
      toneOfVoice: "Amigável",
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

    await page.getByRole("button", { name: "Abrir cliente" }).click();

    // Verify brand details are visible
    await expect(
      page.getByRole("heading", { name: brandName, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Apenas leitura para viewer")).toBeVisible();
    await expect(page.getByText("Consumidores finais")).toBeVisible();

    // Verify write actions are not present
    await expect(page.getByRole("button", { name: "Nova marca" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Editar" })).toHaveCount(0);
  } finally {
    await migration.brand.delete({ where: { id: testBrand.id } });
  }
});
