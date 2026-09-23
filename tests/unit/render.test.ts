import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  hashRenderInput,
  hashTemplateSpec,
  renderArtwork,
  RENDERER_VERSION,
} from "../../packages/render/src/index.js";
import type {
  ArtworkInput,
  DesignFormat,
  DesignTemplateSpec,
} from "../../packages/contracts/src/design.js";

const spec = (format: DesignFormat): DesignTemplateSpec => ({
  schemaVersion: 1,
  format,
  backgroundColor: "#123B35",
  overlayColor: "#071F1C",
  overlayOpacity: 0.35,
  textColor: "#FFFFFF",
  mutedTextColor: "#D6E4DF",
  accentColor: "#E9C46A",
  safeArea: 80,
  textAlign: "left",
  titleMaxLines: 3,
  showEyebrow: true,
  showSubtitle: true,
  showCallToAction: true,
});

const input: ArtworkInput = {
  eyebrow: "SOCIALFLOW",
  title: "Conteúdo que aproxima marcas e pessoas",
  subtitle: "Planeje, aprove e publique com consistência.",
  callToAction: "SAIBA MAIS",
  backgroundMediaAssetId: null,
  logoMediaAssetId: null,
};

describe("static artwork renderer", () => {
  it.each([
    ["SQUARE", 1080, 1080],
    ["PORTRAIT", 1080, 1350],
    ["STORY", 1080, 1920],
  ] as const)("renders deterministic %s PNG", async (format, width, height) => {
    const first = await renderArtwork({ spec: spec(format), input });
    const second = await renderArtwork({ spec: spec(format), input });
    const metadata = await sharp(first.data).metadata();

    expect(first.sha256).toBe(second.sha256);
    expect(first.data.equals(second.data)).toBe(true);
    expect(first.rendererVersion).toBe(RENDERER_VERSION);
    expect(first.mimeType).toBe("image/png");
    expect(metadata.width).toBe(width);
    expect(metadata.height).toBe(height);
    expect(first.byteSize).toBe(first.data.length);
  });

  it("includes validated background pixels without external network access", async () => {
    const backgroundImage = await sharp({
      create: { width: 120, height: 120, channels: 3, background: "#4A2C5A" },
    })
      .png()
      .toBuffer();
    const result = await renderArtwork({
      spec: { ...spec("SQUARE"), overlayOpacity: 0 },
      input,
      backgroundImage,
    });
    expect(result.byteSize).toBeGreaterThan(1_000);
  });

  it("rejects unsupported source images and invalid colors", async () => {
    await expect(
      renderArtwork({
        spec: spec("SQUARE"),
        input,
        backgroundImage: Buffer.from("bad"),
      }),
    ).rejects.toThrow();
    await expect(
      renderArtwork({
        spec: { ...spec("SQUARE"), textColor: "red" },
        input,
      }),
    ).rejects.toThrow();
  });

  it("creates a stable logical input hash", () => {
    const first = hashRenderInput(spec("PORTRAIT"), input);
    const reordered = hashRenderInput({ ...spec("PORTRAIT") }, { ...input });
    expect(first).toBe(reordered);
    expect(first).toHaveLength(64);
    expect(hashRenderInput(spec("STORY"), input)).not.toBe(first);
  });

  it("creates a deterministic spec hash regardless of property ordering", () => {
    const original = spec("PORTRAIT");
    // Create object with reversed keys order
    const reversedKeys = Object.fromEntries(
      Object.entries(original).reverse(),
    ) as DesignTemplateSpec;
    // Create object with shuffled keys order
    const shuffledKeys = {
      showCallToAction: original.showCallToAction,
      accentColor: original.accentColor,
      format: original.format,
      schemaVersion: original.schemaVersion,
      backgroundColor: original.backgroundColor,
      titleMaxLines: original.titleMaxLines,
      textAlign: original.textAlign,
      mutedTextColor: original.mutedTextColor,
      showSubtitle: original.showSubtitle,
      textColor: original.textColor,
      overlayOpacity: original.overlayOpacity,
      safeArea: original.safeArea,
      showEyebrow: original.showEyebrow,
      overlayColor: original.overlayColor,
    } as DesignTemplateSpec;

    const hash1 = hashTemplateSpec(original);
    const hash2 = hashTemplateSpec(reversedKeys);
    const hash3 = hashTemplateSpec(shuffledKeys);

    expect(hash1).toHaveLength(64);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash1).toBe(hash2);
    expect(hash1).toBe(hash3);

    // Any visual modification must change the hash
    expect(
      hashTemplateSpec({ ...original, backgroundColor: "#000000" }),
    ).not.toBe(hash1);
    expect(hashTemplateSpec({ ...original, safeArea: 120 })).not.toBe(hash1);
    expect(hashTemplateSpec({ ...original, format: "SQUARE" })).not.toBe(hash1);
  });

  it("1. Renderer e contrato puro compartilham as mesmas regras de layout sem divergência", async () => {
    const { RENDER_LAYOUT_RULES } =
      await import("../../packages/contracts/src/design.js");

    // Validação estrita dos valores efetivos compartilhados
    expect(RENDER_LAYOUT_RULES.logo).toEqual({
      width: 180,
      height: 90,
      marginBottom: 32,
    });

    expect(RENDER_LAYOUT_RULES.eyebrow).toEqual({
      fontSize: 30,
      fontWeight: 700,
    });

    expect(RENDER_LAYOUT_RULES.title.fontSize).toEqual({
      SQUARE: 72,
      PORTRAIT: 72,
      STORY: 82,
    });
    expect(RENDER_LAYOUT_RULES.title.fontWeight).toBe(700);
    expect(RENDER_LAYOUT_RULES.title.lineHeight).toBe(1.08);
    expect(RENDER_LAYOUT_RULES.title.marginTopWithEyebrow).toBe(28);
    expect(RENDER_LAYOUT_RULES.title.marginTopWithoutEyebrow).toBe(0);

    expect(RENDER_LAYOUT_RULES.subtitle).toEqual({
      fontSize: 34,
      lineHeight: 1.3,
      marginTop: 36,
      maxLines: 3,
    });

    expect(RENDER_LAYOUT_RULES.callToAction.fontSize).toBe(28);
    expect(RENDER_LAYOUT_RULES.callToAction.fontWeight).toBe(700);
    expect(RENDER_LAYOUT_RULES.callToAction.borderRadius).toBe(999);
    expect(RENDER_LAYOUT_RULES.callToAction.padding).toBe("22px 40px");

    // Constantes conservadoras de estimativa permanecem isoladas sob .estimation
    expect(RENDER_LAYOUT_RULES.estimation.logoTotalHeight).toBe(122);
    expect(RENDER_LAYOUT_RULES.estimation.eyebrowLineHeightPx).toBe(36);
    expect(RENDER_LAYOUT_RULES.estimation.titleLineHeightPx.SQUARE).toBeCloseTo(
      77.76,
    );
    expect(RENDER_LAYOUT_RULES.estimation.titleLineHeightPx.STORY).toBeCloseTo(
      88.56,
    );
    expect(RENDER_LAYOUT_RULES.estimation.subtitleLineHeightPx).toBeCloseTo(
      44.2,
    );
    expect(RENDER_LAYOUT_RULES.estimation.callToActionHeight).toBeCloseTo(77.6);
    expect(RENDER_LAYOUT_RULES.estimation.callToActionMinMarginTop).toBe(32);
  });

  it("2. Código-fonte do renderer consome diretamente RENDER_LAYOUT_RULES de @socialflow/contracts", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const rendererSource = readFileSync(
      resolve(process.cwd(), "packages/render/src/index.ts"),
      "utf8",
    );

    // Certifica que o renderer importa e utiliza RENDER_LAYOUT_RULES
    expect(rendererSource).toContain("RENDER_LAYOUT_RULES");
    expect(rendererSource).toContain("RENDER_LAYOUT_RULES.logo.width");
    expect(rendererSource).toContain("RENDER_LAYOUT_RULES.logo.height");
    expect(rendererSource).toContain("RENDER_LAYOUT_RULES.logo.marginBottom");
    expect(rendererSource).toContain("RENDER_LAYOUT_RULES.eyebrow.fontSize");
    expect(rendererSource).toContain("RENDER_LAYOUT_RULES.title.fontSize");
    expect(rendererSource).toContain("RENDER_LAYOUT_RULES.title.lineHeight");
    expect(rendererSource).toContain("RENDER_LAYOUT_RULES.subtitle.fontSize");
    expect(rendererSource).toContain("RENDER_LAYOUT_RULES.subtitle.lineHeight");
    expect(rendererSource).toContain(
      "RENDER_LAYOUT_RULES.callToAction.fontSize",
    );
    expect(rendererSource).toContain(
      "RENDER_LAYOUT_RULES.callToAction.padding",
    );
    expect(rendererSource).toContain(
      "RENDER_LAYOUT_RULES.callToAction.borderRadius",
    );
  });
});
