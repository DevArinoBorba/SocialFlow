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
  expectedBaseVersion: z.number().int().positive(),
  spec: designTemplateSpecSchema,
});
export type DesignTemplateVersionInput = z.infer<
  typeof designTemplateVersionInputSchema
>;

/**
 * Regras e dimensões puras compartilhadas entre o renderer definitivo (Satori/Sharp)
 * e o subsistema de orçamento de layout / prévia client-side.
 *
 * Módulo seguro para navegador: não importa Satori, Sharp, node:fs nem dependências do worker.
 */
export const RENDER_LAYOUT_RULES = {
  logo: {
    width: 180,
    height: 90,
    marginBottom: 32,
  },
  eyebrow: {
    fontSize: 30,
    fontWeight: 700,
  },
  title: {
    fontSize: {
      SQUARE: 72,
      PORTRAIT: 72,
      STORY: 82,
    },
    fontWeight: 700,
    lineHeight: 1.08,
    marginTopWithEyebrow: 28,
    marginTopWithoutEyebrow: 0,
  },
  subtitle: {
    fontSize: 34,
    lineHeight: 1.3,
    marginTop: 36,
    maxLines: 3,
  },
  callToAction: {
    fontSize: 28,
    fontWeight: 700,
    paddingVertical: 22,
    paddingHorizontal: 40,
    padding: "22px 40px",
    borderRadius: 999,
  },
  /**
   * Constantes e heurísticas conservadoras utilizadas exclusivamente para estimativa de layout vertical
   * na prévia e validação de orçamento (calculateLayoutBudget).
   *
   * Partes conservadoras documentadas:
   * 1. Logotipo: totalHeight considera altura (90px) + margem inferior (32px) = 122px.
   * 2. Eyebrow: entrelinha estimada em 36px (fontSize 30 * 1.2 conservador).
   * 3. Título: entrelinhas nominais (72 * 1.08 = 77.76px, 82 * 1.08 = 88.56px).
   * 4. Subtítulo: entrelinha nominal (34 * 1.3 = 44.2px) com margem superior fixa de 36px.
   * 5. Call to Action: no renderer real, o botão utiliza marginTop: 'auto' para ancorar no rodapé.
   *    Para a estimativa de risco de corte/orçamento, adota-se minMarginTop: 32px como margem mínima
   *    conservadora para que o botão não sobreponha ou colida visualmente com o conteúdo acima.
   *    A altura do CTA na estimativa (77.6px) soma a linha de texto estimada (28 * 1.2 = 33.6px)
   *    ao padding vertical total (22 * 2 = 44px).
   */
  estimation: {
    logoTotalHeight: 90 + 32,
    eyebrowLineHeightPx: 36,
    titleLineHeightPx: {
      SQUARE: 72 * 1.08,
      PORTRAIT: 72 * 1.08,
      STORY: 82 * 1.08,
    },
    subtitleLineHeightPx: 34 * 1.3,
    callToActionHeight: 28 * 1.2 + 44,
    callToActionMinMarginTop: 32,
  },
} as const;

export interface LayoutBudgetBlockUsage {
  block: string;
  height: number;
  description: string;
}

export interface LayoutBudgetResult {
  totalHeight: number;
  safeAreaTotal: number;
  availableHeight: number;
  usedHeight: number;
  remainingHeight: number;
  percentUsed: number;
  status: "safe" | "warning" | "overflow";
  responsibleBlocks: string[];
  blockBreakdown: LayoutBudgetBlockUsage[];
  explanation: string;
}

export function calculateLayoutBudget(
  spec: DesignTemplateSpec,
  options?: {
    hasLogo?: boolean;
    textScenario?: "short" | "medium" | "limit";
    customLines?: {
      titleLines?: number;
      subtitleLines?: number;
      hasEyebrow?: boolean;
      hasCta?: boolean;
    };
  },
): LayoutBudgetResult {
  const { height: totalHeight } = designDimensions[spec.format];
  const safeAreaTotal = spec.safeArea * 2;
  const availableHeight = Math.max(0, totalHeight - safeAreaTotal);

  const scenario = options?.textScenario ?? "medium";
  const hasLogo = options?.hasLogo ?? false;

  let titleLines = 2;
  let subtitleLines = 2;
  let hasEyebrow = spec.showEyebrow;
  let hasCta = spec.showCallToAction;

  if (scenario === "short") {
    titleLines = 1;
    subtitleLines = 1;
  } else if (scenario === "medium") {
    titleLines = Math.min(2, spec.titleMaxLines);
    subtitleLines = 2;
  } else if (scenario === "limit") {
    titleLines = spec.titleMaxLines;
    subtitleLines = 3;
  }

  if (options?.customLines) {
    if (options.customLines.titleLines !== undefined) {
      titleLines = Math.min(options.customLines.titleLines, spec.titleMaxLines);
    }
    if (options.customLines.subtitleLines !== undefined) {
      subtitleLines = Math.min(options.customLines.subtitleLines, 3);
    }
    if (options.customLines.hasEyebrow !== undefined) {
      hasEyebrow = spec.showEyebrow && options.customLines.hasEyebrow;
    }
    if (options.customLines.hasCta !== undefined) {
      hasCta = spec.showCallToAction && options.customLines.hasCta;
    }
  }

  const breakdown: LayoutBudgetBlockUsage[] = [];
  let usedHeight = 0;
  const responsibleBlocks: string[] = [];

  if (hasLogo) {
    const h = RENDER_LAYOUT_RULES.estimation.logoTotalHeight;
    breakdown.push({
      block: "Logotipo",
      height: h,
      description: "Logotipo (90px) + margem inferior (32px)",
    });
    usedHeight += h;
  }

  if (hasEyebrow && spec.showEyebrow) {
    const h = RENDER_LAYOUT_RULES.estimation.eyebrowLineHeightPx;
    breakdown.push({
      block: "Chamada superior",
      height: h,
      description: "Chamada superior (30px)",
    });
    usedHeight += h;
  }

  const titleLineH =
    RENDER_LAYOUT_RULES.estimation.titleLineHeightPx[spec.format];
  const titleMargin =
    hasEyebrow && spec.showEyebrow
      ? RENDER_LAYOUT_RULES.title.marginTopWithEyebrow
      : RENDER_LAYOUT_RULES.title.marginTopWithoutEyebrow;
  const titleHeight = Math.round(titleLines * titleLineH) + titleMargin;
  breakdown.push({
    block: "Título principal",
    height: titleHeight,
    description: `Título (${titleLines} linha(s) × ${Math.round(titleLineH)}px + ${titleMargin}px margem)`,
  });
  usedHeight += titleHeight;
  if (titleLines >= 3) {
    responsibleBlocks.push("Título extenso");
  }

  if (spec.showSubtitle && subtitleLines > 0) {
    const subLineH = RENDER_LAYOUT_RULES.estimation.subtitleLineHeightPx;
    const subHeight =
      Math.round(subtitleLines * subLineH) +
      RENDER_LAYOUT_RULES.subtitle.marginTop;
    breakdown.push({
      block: "Subtítulo",
      height: subHeight,
      description: `Subtítulo (${subtitleLines} linha(s) × ${Math.round(subLineH)}px + 36px margem)`,
    });
    usedHeight += subHeight;
    if (subtitleLines >= 3) {
      responsibleBlocks.push("Subtítulo de 3 linhas");
    }
  }

  if (hasCta && spec.showCallToAction) {
    const ctaH =
      Math.round(RENDER_LAYOUT_RULES.estimation.callToActionHeight) +
      RENDER_LAYOUT_RULES.estimation.callToActionMinMarginTop;
    breakdown.push({
      block: "Chamada para Ação (CTA)",
      height: ctaH,
      description: "Botão de CTA (78px + margem mínima de 32px)",
    });
    usedHeight += ctaH;
  }

  if (spec.safeArea >= 160) {
    responsibleBlocks.push(`Área de segurança alta (${spec.safeArea}px)`);
  }

  const remainingHeight = availableHeight - usedHeight;
  const percentUsed = Math.round(
    (usedHeight / Math.max(availableHeight, 1)) * 100,
  );

  let status: "safe" | "warning" | "overflow" = "safe";
  let explanation = `Espaço vertical seguro (estimativa conservadora). Conteúdo consome ${percentUsed}% da área útil (${usedHeight}px de ${availableHeight}px disponíveis).`;

  if (usedHeight > availableHeight) {
    status = "overflow";
    explanation = `Risco de corte (estimativa conservadora): o conteúdo (${usedHeight}px) ultrapassa a área útil disponível (${availableHeight}px) em ${usedHeight - availableHeight}px.`;
  } else if (percentUsed > 80) {
    status = "warning";
    explanation = `Próximo do limite (estimativa conservadora): o conteúdo consome ${percentUsed}% da área útil.`;
  }

  return {
    totalHeight,
    safeAreaTotal,
    availableHeight,
    usedHeight,
    remainingHeight,
    percentUsed,
    status,
    responsibleBlocks,
    blockBreakdown: breakdown,
    explanation,
  };
}

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

export const renderJobStatuses = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type RenderJobStatus = (typeof renderJobStatuses)[number];

export const renderBatchStatuses = [
  "PENDING",
  "PROCESSING",
  "CANCELLING",
  "COMPLETED",
  "PARTIALLY_FAILED",
  "FAILED",
  "CANCELLED",
] as const;
export type RenderBatchStatus = (typeof renderBatchStatuses)[number];

export const renderBatchSourceTypes = [
  "POSTS_SELECTION",
  "CONTENT_BATCH",
] as const;
export type RenderBatchSourceType = (typeof renderBatchSourceTypes)[number];

export const renderBatchSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("POSTS_SELECTION"),
    postIds: z.array(z.string().uuid()).min(1).max(100),
  }),
  z.strictObject({
    type: z.literal("CONTENT_BATCH"),
    contentBatchId: z.string().uuid(),
  }),
]);
export type RenderBatchSource = z.infer<typeof renderBatchSourceSchema>;

export const renderBatchDefaultsSchema = z.strictObject({
  backgroundMediaAssetId: z.string().uuid().nullable().optional().default(null),
  logoMediaAssetId: z.string().uuid().nullable().optional().default(null),
});
export type RenderBatchDefaults = z.infer<typeof renderBatchDefaultsSchema>;

export const renderBatchCreateSchema = z.strictObject({
  templateVersionId: z.string().uuid(),
  format: z.enum(designFormats),
  source: renderBatchSourceSchema,
  defaults: renderBatchDefaultsSchema.optional(),
  idempotencyKey: z.string().trim().min(16).max(128),
});
export type RenderBatchCreate = z.infer<typeof renderBatchCreateSchema>;

export const renderBatchValidateSchema = z.strictObject({
  templateVersionId: z.string().uuid(),
  format: z.enum(designFormats),
  source: renderBatchSourceSchema,
  defaults: renderBatchDefaultsSchema.optional(),
});
export type RenderBatchValidate = z.infer<typeof renderBatchValidateSchema>;

export const renderBatchListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  cursor: z.string().uuid().optional(),
  status: z.enum(renderBatchStatuses).optional(),
});
export type RenderBatchListQuery = z.infer<typeof renderBatchListQuerySchema>;

export const renderBatchItemsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().uuid().optional(),
  status: z.enum(renderJobStatuses).optional(),
});
export type RenderBatchItemsQuery = z.infer<typeof renderBatchItemsQuerySchema>;

export const renderBatchRetryFailedSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(16).max(128),
});
export type RenderBatchRetryFailed = z.infer<
  typeof renderBatchRetryFailedSchema
>;

export interface BatchStatusCounters {
  totalItems: number;
  pendingItems: number;
  processingItems: number;
  completedItems: number;
  failedItems: number;
  cancelledItems: number;
  cancelRequestedAt?: Date | string | null;
}

export function computeBatchAggregateStatus(
  counters: BatchStatusCounters,
): RenderBatchStatus {
  const sum =
    counters.pendingItems +
    counters.processingItems +
    counters.completedItems +
    counters.failedItems +
    counters.cancelledItems;

  const isConsistent = sum === counters.totalItems;

  // Se os contadores forem inconsistentes:
  // - não produza status terminal enganoso;
  // - deixe o lote recuperável pelo reconciliador (CANCELLING se cancelamento solicitado, senão PROCESSING).
  if (!isConsistent) {
    return counters.cancelRequestedAt ? "CANCELLING" : "PROCESSING";
  }

  const isTerminal =
    counters.pendingItems === 0 && counters.processingItems === 0;

  // Enquanto houver itens ativos:
  // - cancelRequestedAt presente -> CANCELLING;
  // - algum item iniciado/terminal -> PROCESSING;
  // - nenhum iniciado -> PENDING.
  if (!isTerminal) {
    if (counters.cancelRequestedAt) {
      return "CANCELLING";
    }
    const hasStartedOrTerminal =
      counters.processingItems > 0 ||
      counters.completedItems > 0 ||
      counters.failedItems > 0 ||
      counters.cancelledItems > 0;

    return hasStartedOrTerminal ? "PROCESSING" : "PENDING";
  }

  // Quando todos forem terminais:
  // - todos COMPLETED -> COMPLETED;
  if (counters.completedItems === counters.totalItems) {
    return "COMPLETED";
  }

  // - todos FAILED -> FAILED;
  if (counters.failedItems === counters.totalItems) {
    return "FAILED";
  }

  // - todos CANCELLED -> CANCELLED;
  if (counters.cancelledItems === counters.totalItems) {
    return "CANCELLED";
  }

  // - qualquer mistura que contenha FAILED -> PARTIALLY_FAILED;
  if (counters.failedItems > 0) {
    return "PARTIALLY_FAILED";
  }

  // - mistura de COMPLETED + CANCELLED sem FAILED -> CANCELLED,
  //   indicando encerramento por cancelamento com resultados preservados.
  if (counters.cancelledItems > 0 && counters.completedItems > 0) {
    return "CANCELLED";
  }

  return "COMPLETED";
}

export interface RenderBatchDto {
  id: string;
  templateVersionId: string;
  sourceType: RenderBatchSourceType;
  contentBatchId: string | null;
  parentBatchId: string | null;
  format: DesignFormat;
  status: RenderBatchStatus;
  requestHash: string;
  totalItems: number;
  pendingItems: number;
  processingItems: number;
  completedItems: number;
  failedItems: number;
  cancelledItems: number;
  cancelRequestedAt: string | null;
  cancelCompletedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RenderBatchItemDto {
  id: string;
  status: RenderJobStatus;
  templateVersionId: string;
  postId: string | null;
  backgroundMediaAssetId: string | null;
  logoMediaAssetId: string | null;
  outputMediaAssetId: string | null;
  outputMediaUrl: string | null;
  attemptNumber: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RenderBatchValidateResult {
  valid: boolean;
  totalRequested: number;
  validItemsCount: number;
  invalidItemsCount: number;
  validItems: Array<{ index: number; postId?: string; input: ArtworkInput }>;
  invalidItems: Array<{ index: number; postId?: string; reasons: string[] }>;
  estimatedDurationMs: number;
}
