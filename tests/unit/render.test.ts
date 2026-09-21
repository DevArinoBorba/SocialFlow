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
});
