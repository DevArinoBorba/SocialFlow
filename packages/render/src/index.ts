import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import satori from "satori";
import sharp from "sharp";
import {
  artworkInputSchema,
  designDimensions,
  designTemplateSpecSchema,
  RENDER_LAYOUT_RULES,
  type ArtworkInput,
  type DesignTemplateSpec,
} from "@socialflow/contracts";

export const RENDERER_VERSION = "satori-0.33.4_sharp-0.35.4_v1";
export const MAX_RENDER_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_RENDER_SOURCE_PIXELS = 25_000_000;

const regularFontUrl = new URL(
  "../node_modules/@fontsource/inter/files/inter-latin-ext-400-normal.woff",
  import.meta.url,
);
const boldFontUrl = new URL(
  "../node_modules/@fontsource/inter/files/inter-latin-ext-700-normal.woff",
  import.meta.url,
);
let defaultFontsPromise: Promise<RenderFont[]> | undefined;

export type RenderFont = {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
};

export type ArtworkRenderOptions = {
  spec: DesignTemplateSpec;
  input: ArtworkInput;
  backgroundImage?: Buffer;
  logoImage?: Buffer;
  fonts?: RenderFont[];
};

export type ArtworkRenderResult = {
  data: Buffer;
  mimeType: "image/png";
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  rendererVersion: string;
};

async function loadDefaultFonts() {
  defaultFontsPromise ??= Promise.all([
    readFile(fileURLToPath(regularFontUrl)),
    readFile(fileURLToPath(boldFontUrl)),
  ]).then(
    ([regular, bold]) =>
      [
        { name: "Inter", data: regular, weight: 400, style: "normal" },
        { name: "Inter", data: bold, weight: 700, style: "normal" },
      ] as RenderFont[],
  );
  return defaultFontsPromise;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

export function hashTemplateSpec(spec: DesignTemplateSpec): string {
  const normalized = JSON.stringify(stable(spec));
  return createHash("sha256").update(normalized).digest("hex");
}

export function hashRenderInput(spec: DesignTemplateSpec, input: ArtworkInput) {
  const normalized = JSON.stringify(
    stable({ rendererVersion: RENDERER_VERSION, spec, input }),
  );
  return createHash("sha256").update(normalized).digest("hex");
}

export function computeBatchRequestFingerprint(params: {
  organizationId: string;
  clientId: string;
  templateVersionId: string;
  format: string;
  sourceType: "POSTS_SELECTION" | "CONTENT_BATCH";
  resolvedPostIds: string[];
  defaults?: {
    backgroundMediaAssetId?: string | null;
    logoMediaAssetId?: string | null;
  };
}): string {
  const normalized = JSON.stringify(
    stable({
      organizationId: params.organizationId,
      clientId: params.clientId,
      templateVersionId: params.templateVersionId,
      format: params.format,
      sourceType: params.sourceType,
      resolvedPostIds: [...params.resolvedPostIds].sort(),
      backgroundMediaAssetId: params.defaults?.backgroundMediaAssetId ?? null,
      logoMediaAssetId: params.defaults?.logoMediaAssetId ?? null,
    }),
  );
  return createHash("sha256").update(normalized).digest("hex");
}

async function imageDataUrl(data: Buffer | undefined) {
  if (!data) return undefined;
  if (!data.length || data.length > MAX_RENDER_SOURCE_BYTES)
    throw new Error("Invalid render source image size");
  const metadata = await sharp(data, {
    failOn: "warning",
    limitInputPixels: MAX_RENDER_SOURCE_PIXELS,
  }).metadata();
  if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format))
    throw new Error("Unsupported render source image");
  const mime =
    metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
  return `data:${mime};base64,${data.toString("base64")}`;
}

const element = (
  style: Record<string, unknown>,
  children: unknown,
  type = "div",
) =>
  ({
    type,
    props: { style, children },
  }) as Parameters<typeof satori>[0];

export async function renderArtwork(
  options: ArtworkRenderOptions,
): Promise<ArtworkRenderResult> {
  const spec = designTemplateSpecSchema.parse(options.spec);
  const input = artworkInputSchema.parse(options.input);
  const { width, height } = designDimensions[spec.format];
  const fonts = options.fonts ?? (await loadDefaultFonts());
  if (!fonts.length) throw new Error("At least one approved font is required");

  const background = await imageDataUrl(options.backgroundImage);
  const logo = await imageDataUrl(options.logoImage);
  const alignItems =
    spec.textAlign === "center"
      ? "center"
      : spec.textAlign === "right"
        ? "flex-end"
        : "flex-start";

  const children: unknown[] = [];
  if (background)
    children.push({
      type: "img",
      props: {
        src: background,
        width,
        height,
        style: {
          position: "absolute",
          inset: 0,
          width,
          height,
          objectFit: "cover",
        },
      },
    });
  children.push(
    element(
      {
        position: "absolute",
        inset: 0,
        width,
        height,
        backgroundColor: spec.overlayColor,
        opacity: spec.overlayOpacity,
      },
      "",
    ),
  );
  const content: unknown[] = [];
  if (logo)
    content.push({
      type: "img",
      props: {
        src: logo,
        width: RENDER_LAYOUT_RULES.logo.width,
        height: RENDER_LAYOUT_RULES.logo.height,
        style: {
          objectFit: "contain",
          marginBottom: RENDER_LAYOUT_RULES.logo.marginBottom,
        },
      },
    });
  if (spec.showEyebrow && input.eyebrow)
    content.push(
      element(
        {
          color: spec.accentColor,
          fontSize: RENDER_LAYOUT_RULES.eyebrow.fontSize,
          fontWeight: RENDER_LAYOUT_RULES.eyebrow.fontWeight,
        },
        input.eyebrow,
      ),
    );
  content.push(
    element(
      {
        display: "block",
        color: spec.textColor,
        fontSize: RENDER_LAYOUT_RULES.title.fontSize[spec.format],
        fontWeight: RENDER_LAYOUT_RULES.title.fontWeight,
        lineHeight: RENDER_LAYOUT_RULES.title.lineHeight,
        lineClamp: spec.titleMaxLines,
        textAlign: spec.textAlign,
        textWrap: "balance",
        marginTop: input.eyebrow
          ? RENDER_LAYOUT_RULES.title.marginTopWithEyebrow
          : RENDER_LAYOUT_RULES.title.marginTopWithoutEyebrow,
        overflow: "hidden",
      },
      input.title,
    ),
  );
  if (spec.showSubtitle && input.subtitle)
    content.push(
      element(
        {
          display: "block",
          color: spec.mutedTextColor,
          fontSize: RENDER_LAYOUT_RULES.subtitle.fontSize,
          lineHeight: RENDER_LAYOUT_RULES.subtitle.lineHeight,
          lineClamp: RENDER_LAYOUT_RULES.subtitle.maxLines,
          textAlign: spec.textAlign,
          marginTop: RENDER_LAYOUT_RULES.subtitle.marginTop,
          overflow: "hidden",
        },
        input.subtitle,
      ),
    );
  if (spec.showCallToAction && input.callToAction)
    content.push(
      element(
        {
          marginTop: "auto",
          backgroundColor: spec.accentColor,
          color: spec.backgroundColor,
          borderRadius: RENDER_LAYOUT_RULES.callToAction.borderRadius,
          padding: RENDER_LAYOUT_RULES.callToAction.padding,
          fontSize: RENDER_LAYOUT_RULES.callToAction.fontSize,
          fontWeight: RENDER_LAYOUT_RULES.callToAction.fontWeight,
        },
        input.callToAction,
      ),
    );
  children.push(
    element(
      {
        position: "relative",
        width,
        height,
        padding: spec.safeArea,
        display: "flex",
        flexDirection: "column",
        alignItems,
        fontFamily: "Inter",
      },
      content,
    ),
  );

  const svg = await satori(
    element(
      {
        position: "relative",
        width,
        height,
        display: "flex",
        overflow: "hidden",
        backgroundColor: spec.backgroundColor,
      },
      children,
    ),
    { width, height, fonts },
  );
  const data = await sharp(Buffer.from(svg), {
    density: 72,
    failOn: "warning",
    limitInputPixels: MAX_RENDER_SOURCE_PIXELS,
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  return {
    data,
    mimeType: "image/png",
    width,
    height,
    byteSize: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    rendererVersion: RENDERER_VERSION,
  };
}
