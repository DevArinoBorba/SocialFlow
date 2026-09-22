/**
 * design-contrast.ts
 *
 * Módulo puro de análise determinística de contraste de cores segundo as
 * diretrizes WCAG 2.1.
 *
 * Critérios WCAG 2.1:
 * - Texto Normal (< 18pt regular [~24px] ou < 14pt negrito [~18.66px]):
 *     - Nível AA: mínimo 4.5:1
 *     - Nível AAA: mínimo 7.0:1
 * - Texto Grande (>= 18pt regular [~24px] ou >= 14pt negrito [~18.66px]):
 *     - Nível AA: mínimo 3.0:1
 *     - Nível AAA: mínimo 4.5:1
 *
 * Classificação no Renderer do SocialFlow:
 * - Título: 72px (Square/Portrait) ou 82px (Story) negrito -> Texto Grande
 * - Subtítulo: 34px regular -> Texto Grande (>= 24px)
 * - Chamada Superior (Eyebrow): 30px negrito -> Texto Grande (>= 18.66px)
 * - Chamada para Ação (CTA): 28px negrito -> Texto Grande (>= 18.66px)
 *   (Calculado entre o texto do botão [backgroundColor] e o fundo do botão [accentColor])
 */

export interface RgbColor {
  r: number; // 0..255
  g: number; // 0..255
  b: number; // 0..255
}

export type ContrastStatus = "APPROVED" | "WARNING" | "FAILED";
export type TextSizeCategory = "normal" | "large";
export type WcagLevel = "AAA" | "AA" | "FAIL";

export interface ElementContrastResult {
  element: "title" | "subtitle" | "eyebrow" | "callToAction";
  label: string;
  category: TextSizeCategory;
  foregroundHex: string;
  backgroundHex: string;
  ratio: number;
  formattedRatio: string;
  status: ContrastStatus;
  wcagLevel: WcagLevel;
  statusLabel: string;
  explanation: string;
}

export interface DesignContrastAnalysis {
  effectiveBackgroundHex: string;
  isBackgroundEstimated: boolean;
  hasWarning: boolean;
  hasFailure: boolean;
  failedElements: ElementContrastResult[];
  elements: ElementContrastResult[];
}

/**
 * Converte string hexadecimal #RRGGBB em componentes RGB numéricos.
 * Retorna null se a string for inválida.
 */
export function hexToRgb(hex: string): RgbColor | null {
  if (!hex || typeof hex !== "string") return null;
  const match = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(
    hex.trim(),
  );
  if (!match) return null;
  return {
    r: parseInt(match[1]!, 16),
    g: parseInt(match[2]!, 16),
    b: parseInt(match[3]!, 16),
  };
}

/**
 * Converte componentes RGB numéricos em string hexadecimal normalizada (#RRGGBB).
 */
export function rgbToHex(rgb: RgbColor): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const toHex = (v: number) =>
    clamp(v).toString(16).padStart(2, "0").toUpperCase();
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

/**
 * Calcula a composição alfa (alpha blending) entre uma cor de sobreposição e uma cor base:
 * C_efetivo = C_overlay * alpha + C_base * (1 - alpha)
 */
export function blendColors(
  base: RgbColor,
  overlay: RgbColor,
  opacity: number,
): RgbColor {
  const alpha = Math.max(0, Math.min(1, opacity));
  return {
    r: Math.round(overlay.r * alpha + base.r * (1 - alpha)),
    g: Math.round(overlay.g * alpha + base.g * (1 - alpha)),
    b: Math.round(overlay.b * alpha + base.b * (1 - alpha)),
  };
}

/**
 * Converte componente de canal (0..255) em componente linearizado sRGB.
 */
function channelToLinear(c255: number): number {
  const c = Math.max(0, Math.min(255, c255)) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Calcula a luminância relativa conforme WCAG 2.1:
 * L = 0.2126 * R_lin + 0.7152 * G_lin + 0.0722 * B_lin
 */
export function calculateRelativeLuminance(rgb: RgbColor): number {
  const rLin = channelToLinear(rgb.r);
  const gLin = channelToLinear(rgb.g);
  const bLin = channelToLinear(rgb.b);
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/**
 * Calcula a razão de contraste entre duas cores (retorna valor entre 1.0 e 21.0).
 * CR = (L1 + 0.05) / (L2 + 0.05)
 */
export function calculateContrastRatio(
  colorA: RgbColor,
  colorB: RgbColor,
): number {
  const l1 = calculateRelativeLuminance(colorA);
  const l2 = calculateRelativeLuminance(colorB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  const ratio = (lighter + 0.05) / (darker + 0.05);
  return Math.round(ratio * 100) / 100;
}

/**
 * Determina o nível de conformidade WCAG 2.1 ('AAA' | 'AA' | 'FAIL')
 * para uma razão de contraste e categoria de texto.
 */
export function evaluateWcagLevel(
  ratio: number,
  category: TextSizeCategory = "large",
): WcagLevel {
  if (category === "large") {
    if (ratio >= 4.5) return "AAA";
    if (ratio >= 3.0) return "AA";
    return "FAIL";
  }
  if (ratio >= 7.0) return "AAA";
  if (ratio >= 4.5) return "AA";
  return "FAIL";
}

/**
 * Avalia a razão de contraste segundo WCAG 2.1 diferenciando rigorosamente
 * texto grande (>= 18.5px bold ou >= 24px) e texto normal.
 */
export function evaluateContrast(
  ratio: number,
  category: TextSizeCategory = "large",
): {
  status: ContrastStatus;
  wcagLevel: WcagLevel;
  statusLabel: string;
  explanation: string;
} {
  if (category === "large") {
    // Texto grande:
    // AAA: >= 4.5:1
    // AA:  >= 3.0:1
    // FAIL: < 3.0:1
    if (ratio >= 4.5) {
      return {
        status: "APPROVED",
        wcagLevel: "AAA",
        statusLabel: "Aprovado (AAA)",
        explanation: `Excelente contraste (${ratio.toFixed(1)}:1). Atende WCAG 2.1 nível AAA para texto grande (mínimo 4.5:1).`,
      };
    }
    if (ratio >= 3.0) {
      return {
        status: "APPROVED",
        wcagLevel: "AA",
        statusLabel: "Aprovado (AA)",
        explanation: `Bom contraste (${ratio.toFixed(1)}:1). Atende WCAG 2.1 nível AA para texto grande (mínimo 3.0:1).`,
      };
    }
    return {
      status: "FAILED",
      wcagLevel: "FAIL",
      statusLabel: "Reprovado",
      explanation: `Contraste insuficiente (${ratio.toFixed(1)}:1). Abaixo do mínimo exigido por WCAG 2.1 nível AA para texto grande (3.0:1).`,
    };
  }

  // Texto normal:
  // AAA: >= 7.0:1
  // AA:  >= 4.5:1
  // FAIL: < 4.5:1
  if (ratio >= 7.0) {
    return {
      status: "APPROVED",
      wcagLevel: "AAA",
      statusLabel: "Aprovado (AAA)",
      explanation: `Excelente contraste (${ratio.toFixed(1)}:1). Atende WCAG 2.1 nível AAA para texto normal (mínimo 7.0:1).`,
    };
  }
  if (ratio >= 4.5) {
    return {
      status: "APPROVED",
      wcagLevel: "AA",
      statusLabel: "Aprovado (AA)",
      explanation: `Bom contraste (${ratio.toFixed(1)}:1). Atende WCAG 2.1 nível AA para texto normal (mínimo 4.5:1).`,
    };
  }
  if (ratio >= 3.0) {
    return {
      status: "WARNING",
      wcagLevel: "FAIL",
      statusLabel: "Atenção",
      explanation: `Contraste moderado (${ratio.toFixed(1)}:1). Aceitável para texto grande, mas reprovado para texto normal perante WCAG 2.1 nível AA (mínimo 4.5:1).`,
    };
  }
  return {
    status: "FAILED",
    wcagLevel: "FAIL",
    statusLabel: "Reprovado",
    explanation: `Baixo contraste crítico (${ratio.toFixed(1)}:1). Severamente abaixo das diretrizes WCAG 2.1 (< 3.0:1).`,
  };
}

/**
 * Analisa o contraste completo de uma especificação de template de design.
 */
export function analyzeTemplateContrast(params: {
  backgroundColor: string;
  overlayColor: string;
  overlayOpacity: number;
  textColor: string;
  mutedTextColor: string;
  accentColor: string;
  showEyebrow?: boolean;
  showSubtitle?: boolean;
  showCallToAction?: boolean;
  hasBackgroundImage?: boolean;
}): DesignContrastAnalysis {
  const baseRgb = hexToRgb(params.backgroundColor) ?? { r: 15, g: 23, b: 42 };
  const overlayRgb = hexToRgb(params.overlayColor) ?? { r: 2, g: 6, b: 23 };
  const effectiveBgRgb = blendColors(
    baseRgb,
    overlayRgb,
    params.overlayOpacity,
  );
  const effectiveBgHex = rgbToHex(effectiveBgRgb);

  const textRgb = hexToRgb(params.textColor) ?? { r: 255, g: 255, b: 255 };
  const mutedTextRgb = hexToRgb(params.mutedTextColor) ?? {
    r: 148,
    g: 163,
    b: 184,
  };
  const accentRgb = hexToRgb(params.accentColor) ?? { r: 56, g: 189, b: 248 };

  const elements: ElementContrastResult[] = [];

  // 1. Título principal (renderizado em 72px ou 82px negrito -> Texto Grande)
  const titleRatio = calculateContrastRatio(textRgb, effectiveBgRgb);
  const titleEval = evaluateContrast(titleRatio, "large");
  elements.push({
    element: "title",
    label: "Título Principal",
    category: "large",
    foregroundHex: params.textColor,
    backgroundHex: effectiveBgHex,
    ratio: titleRatio,
    formattedRatio: `${titleRatio.toFixed(1)}:1`,
    status: titleEval.status,
    wcagLevel: titleEval.wcagLevel,
    statusLabel: titleEval.statusLabel,
    explanation: titleEval.explanation,
  });

  // 2. Texto secundário / subtítulo (renderizado em 34px regular -> Texto Grande >= 24px)
  if (params.showSubtitle !== false) {
    const subtitleRatio = calculateContrastRatio(mutedTextRgb, effectiveBgRgb);
    const subtitleEval = evaluateContrast(subtitleRatio, "large");
    elements.push({
      element: "subtitle",
      label: "Subtítulo",
      category: "large",
      foregroundHex: params.mutedTextColor,
      backgroundHex: effectiveBgHex,
      ratio: subtitleRatio,
      formattedRatio: `${subtitleRatio.toFixed(1)}:1`,
      status: subtitleEval.status,
      wcagLevel: subtitleEval.wcagLevel,
      statusLabel: subtitleEval.statusLabel,
      explanation: subtitleEval.explanation,
    });
  }

  // 3. Chamada superior / eyebrow (renderizado em 30px negrito -> Texto Grande >= 18.66px)
  if (params.showEyebrow !== false) {
    const eyebrowRatio = calculateContrastRatio(accentRgb, effectiveBgRgb);
    const eyebrowEval = evaluateContrast(eyebrowRatio, "large");
    elements.push({
      element: "eyebrow",
      label: "Chamada Superior",
      category: "large",
      foregroundHex: params.accentColor,
      backgroundHex: effectiveBgHex,
      ratio: eyebrowRatio,
      formattedRatio: `${eyebrowRatio.toFixed(1)}:1`,
      status: eyebrowEval.status,
      wcagLevel: eyebrowEval.wcagLevel,
      statusLabel: eyebrowEval.statusLabel,
      explanation: eyebrowEval.explanation,
    });
  }

  // 4. Botão de CTA: texto (backgroundColor) sobre fundo do botão (accentColor) (28px negrito -> Texto Grande)
  if (params.showCallToAction !== false) {
    const ctaRatio = calculateContrastRatio(baseRgb, accentRgb);
    const ctaEval = evaluateContrast(ctaRatio, "large");
    elements.push({
      element: "callToAction",
      label: "Chamada para Ação (CTA)",
      category: "large",
      foregroundHex: params.backgroundColor,
      backgroundHex: params.accentColor,
      ratio: ctaRatio,
      formattedRatio: `${ctaRatio.toFixed(1)}:1`,
      status: ctaEval.status,
      wcagLevel: ctaEval.wcagLevel,
      statusLabel: ctaEval.statusLabel,
      explanation: `Contraste do texto sobre o botão (${ctaRatio.toFixed(1)}:1). ${ctaEval.explanation}`,
    });
  }

  const hasWarning = elements.some((e) => e.status === "WARNING");
  const hasFailure = elements.some((e) => e.status === "FAILED");
  const failedElements = elements.filter((e) => e.status === "FAILED");

  return {
    effectiveBackgroundHex: effectiveBgHex,
    isBackgroundEstimated: Boolean(params.hasBackgroundImage),
    hasWarning,
    hasFailure,
    failedElements,
    elements,
  };
}
