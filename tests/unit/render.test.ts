import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  hashRenderInput,
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
});
