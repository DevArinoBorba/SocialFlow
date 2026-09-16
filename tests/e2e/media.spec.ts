import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { createDatabase } from "../../packages/db/src/index.js";
const db = createDatabase(process.env.MIGRATION_DATABASE_URL!);
test.beforeEach(async () => {
  await db.rateLimit.deleteMany();
});
test.afterAll(async () => {
  await db.$disconnect();
});
test("image library uploads, previews, edits and archives", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("admin-a@socialflow.test");
  await page
    .getByLabel("Senha", { exact: true })
    .fill(process.env.DEV_SEED_PASSWORD!);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: "Abrir cliente" }).first().click();
  const library = page.getByRole("region", { name: "Biblioteca de imagens" });
  await library.getByText("Adicionar imagem", { exact: true }).click();
  const name = `Paisagem ${Date.now()}`;
  await library.getByLabel("Nome da imagem").fill(name);
  await library
    .getByLabel("Sobre a imagem")
    .fill("Imagem de teste da biblioteca");
  const bytes = await sharp({
    create: { width: 480, height: 320, channels: 3, background: "#285844" },
  })
    .png()
    .toBuffer();
  await library.getByLabel("Arquivo").setInputFiles({
    name: "paisagem.png",
    mimeType: "image/png",
    buffer: bytes,
  });
  await library.getByRole("button", { name: "Enviar imagem" }).click();
  const item = library
    .locator("article")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(item).toBeVisible();
  await expect(item.locator("img")).toHaveJSProperty("naturalWidth", 480);
  await page.screenshot({
    path: info.outputPath("media-library.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await item.getByRole("button", { name: "Editar imagem" }).click();
  await item.getByLabel("Nome da imagem").fill(`${name} editada`);
  await item.getByRole("button", { name: "Salvar imagem" }).click();
  const edited = library.locator("article").filter({
    has: page.getByRole("heading", { name: `${name} editada`, exact: true }),
  });
  await expect(edited).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Clientes", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Abrir cliente" }).first().click();
  const reloadedLibrary = page.getByRole("region", {
    name: "Biblioteca de imagens",
  });
  await expect(reloadedLibrary).toBeVisible();
  const reloadedItem = reloadedLibrary.locator("article").filter({
    has: page.getByRole("heading", { name: `${name} editada`, exact: true }),
  });
  await expect(reloadedItem).toBeVisible();
  await reloadedItem.getByRole("button", { name: "Arquivar imagem" }).click();
  await expect(reloadedItem).toHaveCount(0);
});
