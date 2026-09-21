import { z } from "zod";

export const designFormats = ["SQUARE", "PORTRAIT", "STORY"] as const;
export type DesignFormat = (typeof designFormats)[number];

export const systemTemplateKeys = [
  "EDITORIAL_SQUARE",
  "EDITORIAL_PORTRAIT",
  "EDITORIAL_STORY",
] as const;
export type SystemTemplateKey = (typeof systemTemplateKeys)[number];

export const designDimensions: Record<
  DesignFormat,
  { width: number; height: number }
> = {
  SQUARE: { width: 1080, height: 1080 },
  PORTRAIT: { width: 1080, height: 1350 },
  STORY: { width: 1080, height: 1920 },
};

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const designTemplateSpecSchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.enum(designFormats),
  backgroundColor: color,
  overlayColor: color,
  overlayOpacity: z.number().min(0).max(1),
  textColor: color,
  mutedTextColor: color,
  accentColor: color,
  safeArea: z.number().int().min(40).max(240),
  textAlign: z.enum(["left", "center", "right"]),
  titleMaxLines: z.number().int().min(1).max(4),
  showEyebrow: z.boolean(),
  showSubtitle: z.boolean(),
  showCallToAction: z.boolean(),
});
export type DesignTemplateSpec = z.infer<typeof designTemplateSpecSchema>;

export const designTemplateInputSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  spec: designTemplateSpecSchema,
});
export type DesignTemplateInput = z.infer<typeof designTemplateInputSchema>;

export const designTemplatePatchSchema = z
  .strictObject({
    name: z.string().trim().min(2).max(120).optional(),
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  })
  .refine((data) => data.name !== undefined || data.status !== undefined, {
    message: "Pelo menos um campo deve ser informado para atualização.",
  });
export type DesignTemplatePatch = z.infer<typeof designTemplatePatchSchema>;

export const designTemplateVersionInputSchema = z.strictObject({
  spec: designTemplateSpecSchema,
});
export type DesignTemplateVersionInput = z.infer<
  typeof designTemplateVersionInputSchema
>;

export const designTemplateDuplicateInputSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
});
export type DesignTemplateDuplicateInput = z.infer<
  typeof designTemplateDuplicateInputSchema
>;

export const designTemplateListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  cursor: z.string().uuid().optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  search: z.string().trim().max(100).optional(),
});
export type DesignTemplateListQuery = z.infer<
  typeof designTemplateListQuerySchema
>;

export const artworkInputSchema = z.strictObject({
  eyebrow: z.string().trim().max(60).optional().default(""),
  title: z.string().trim().min(1).max(180),
  subtitle: z.string().trim().max(300).optional().default(""),
  callToAction: z.string().trim().max(40).optional().default(""),
  backgroundMediaAssetId: z.string().uuid().nullable().optional().default(null),
  logoMediaAssetId: z.string().uuid().nullable().optional().default(null),
});
export type ArtworkInput = z.infer<typeof artworkInputSchema>;

export const renderRequestSchema = z.strictObject({
  templateVersionId: z.string().uuid(),
  postId: z.string().uuid().nullable().optional().default(null),
  input: artworkInputSchema,
  idempotencyKey: z.string().trim().min(16).max(128),
});
export type RenderRequest = z.infer<typeof renderRequestSchema>;
