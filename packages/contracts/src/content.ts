import { z } from "zod";

export const batchStatuses = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
] as const;
export type BatchStatus = (typeof batchStatuses)[number];

export const postStatuses = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
] as const;
export type PostStatus = (typeof postStatuses)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((val) => (val === "" || val === undefined ? null : val));

export const MAX_CSV_SIZE_BYTES = 2 * 1024 * 1024; // 2 MiB
export const MAX_CSV_DATA_ROWS = 500;

export const importErrorSchema = z.strictObject({
  row: z.number().int().min(1),
  column: z.string().min(1).max(80),
  message: z.string().min(1).max(500),
  rawValue: z.string().max(1000).optional(),
});
export type ImportError = z.infer<typeof importErrorSchema>;

export const contentBatchInput = z.strictObject({
  name: z.string().trim().min(2).max(120),
  sourceType: z.literal("CSV").default("CSV"),
});
export type ContentBatchInput = z.infer<typeof contentBatchInput>;

export const contentBatchSchema = z.strictObject({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  sourceType: z.string(),
  status: z.enum(batchStatuses),
  totalRows: z.number().int().min(0),
  validRows: z.number().int().min(0),
  invalidRows: z.number().int().min(0),
  errorReport: z.array(importErrorSchema).nullable(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
});
export type ContentBatch = z.infer<typeof contentBatchSchema>;

export const postInput = z.strictObject({
  title: optionalText(120),
  caption: z.string().trim().min(1).max(5000),
  hashtags: optionalText(1000),
  callToAction: optionalText(500),
  firstComment: optionalText(2200),
  suggestedDate: z
    .string()
    .datetime({ offset: true })
    .or(z.string().datetime())
    .optional()
    .nullable()
    .transform((val) => (val === "" || val === undefined ? null : val)),
  brandId: z
    .string()
    .uuid()
    .optional()
    .nullable()
    .transform((val) => (val === "" || val === undefined ? null : val)),
});
export type PostInput = z.infer<typeof postInput>;

export const postUpdate = postInput;
export type PostUpdate = z.infer<typeof postUpdate>;

export const postStatusTransition = z.strictObject({
  status: z.enum(postStatuses),
  rejectionReason: optionalText(2000),
});
export type PostStatusTransition = z.infer<typeof postStatusTransition>;

export const postSchema = z.strictObject({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  batchId: z.string().uuid().nullable(),
  brandId: z.string().uuid().nullable(),
  status: z.enum(postStatuses),
  title: z.string().nullable(),
  caption: z.string(),
  hashtags: z.string().nullable(),
  callToAction: z.string().nullable(),
  firstComment: z.string().nullable(),
  suggestedDate: z.union([z.string(), z.date()]).nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
});
export type Post = z.infer<typeof postSchema>;
