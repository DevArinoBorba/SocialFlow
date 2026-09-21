/**
 * design-contrast.ts
 *
 * Módulo puro de análise determinística de contraste de cores segundo as
 * diretrizes WCAG 2.1.
 *
 * Regras e Fórmulas:
 * 1. Conversão sRGB para componente linear:
 *    Se C <= 0.04045, C_linear = C / 12.92
 *    Senão, C_linear = ((C + 0.055) / 1.055) ^ 2.4
 * 2. Luminância relativa (L):
 *    L = 0.2126 * R_linear + 0.7152 * G_linear + 0.0722 * B_linear
 * 3. Composição de cor (Alpha Blending):
 *    Quando uma sobreposição (overlay) de cor Co e opacidade alpha (0..1)
 *    é aplicada sobre um fundo sólido Cb:
 *    C_efetivo = Co * alpha + Cb * (1 - alpha)
 * 4. Razão de contraste (CR):
 *    CR = (L1 + 0.05) / (L2 + 0.05), onde L1 >= L2.
 * 5. Classificação:
 *    - Aprovado: CR >= 4.5:1 (atende WCAG AA para texto normal e AAA para texto grande)
 *    - Atenção: CR >= 3.0:1 e < 4.5:1 (atende WCAG AA para texto grande / títulos destacados)
 *    - Reprovado: CR < 3.0:1 (baixa legibilidade, reprovado para textos principais)
 */

export interface RgbColor {
  r: number; // 0..255
  g: number; // 0..255
  b: number; // 0..255
}

export type ContrastStatus = "APPROVED" | "WARNING" | "FAILED";

export interface ElementContrastResult {
  element: "title" | "subtitle" | "eyebrow" | "callToAction";
  label: string;
  foregroundHex: string;
  backgroundHex: string;
  ratio: number;
  formattedRatio: string;
  status: ContrastStatus;
  statusLabel: string;
  explanation: string;
}

export interface DesignContrastAnalysis {
  effectiveBackgroundHex: string;
  isBackgroundEstimated: boolean;
  hasWarning: boolean;
  hasFailure: boolean;
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
 * Calcula a composição alfa (alpha blending) entre uma cor de sobreposição e uma cor base.
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
 * Calcula a luminância relativa conforme WCAG 2.1.
 */
export function calculateRelativeLuminance(rgb: RgbColor): number {
  const rLin = channelToLinear(rgb.r);
  const gLin = channelToLinear(rgb.g);
  const bLin = channelToLinear(rgb.b);
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/**
 * Calcula a razão de contraste entre duas cores (retorna valor entre 1.0 e 21.0).
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
  // Arredonda para 2 casas decimais
  return Math.round(ratio * 100) / 100;
}

/**
 * Avalia a razão de contraste segundo WCAG 2.1 para textos grandes (>= 18.5px bold ou >= 24px)
 * e textos normais.
 */
export function evaluateContrast(
  ratio: number,
  isLargeText = true,
): { status: ContrastStatus; statusLabel: string; explanation: string } {
  if (ratio >= 4.5) {
    return {
      status: "APPROVED",
      statusLabel: "Aprovado",
      explanation: `Excelente contraste (${ratio.toFixed(1)}:1). Atende WCAG AA e AAA.`,
    };
  }
  if (ratio >= 3.0) {
    if (isLargeText) {
      return {
        status: "APPROVED",
        statusLabel: "Aprovado (Texto Grande)",
        explanation: `Bom contraste (${ratio.toFixed(1)}:1). Atende WCAG AA para textos de destaque e títulos.`,
      };
    }
    return {
      status: "WARNING",
      statusLabel: "Atenção",
      explanation: `Contraste moderado (${ratio.toFixed(1)}:1). Aceitável para títulos grandes, mas insuficiente para textos pequenos.`,
    };
  }
  return {
    status: "FAILED",
    statusLabel: "Reprovado",
    explanation: `Baixo contraste (${ratio.toFixed(1)}:1). Legibilidade comprometida perante as diretrizes WCAG (< 3.0:1).`,
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

  // 1. Título principal (renderizado em 72px a 82px bold - Texto Grande)
  const titleRatio = calculateContrastRatio(textRgb, effectiveBgRgb);
  const titleEval = evaluateContrast(titleRatio, true);
  elements.push({
    element: "title",
    label: "Título Principal",
    foregroundHex: params.textColor,
    backgroundHex: effectiveBgHex,
    ratio: titleRatio,
    formattedRatio: `${titleRatio.toFixed(1)}:1`,
    status: titleEval.status,
    statusLabel: titleEval.statusLabel,
    explanation: titleEval.explanation,
  });

  // 2. Texto secundário / subtítulo (renderizado em 34px - Texto Grande)
  if (params.showSubtitle !== false) {
    const subtitleRatio = calculateContrastRatio(mutedTextRgb, effectiveBgRgb);
    const subtitleEval = evaluateContrast(subtitleRatio, true);
    elements.push({
      element: "subtitle",
      label: "Subtítulo",
      foregroundHex: params.mutedTextColor,
      backgroundHex: effectiveBgHex,
      ratio: subtitleRatio,
      formattedRatio: `${subtitleRatio.toFixed(1)}:1`,
      status: subtitleEval.status,
      statusLabel: subtitleEval.statusLabel,
      explanation: subtitleEval.explanation,
    });
  }

  // 3. Chamada superior / eyebrow (renderizado em 30px bold - Texto Grande)
  if (params.showEyebrow !== false) {
    const eyebrowRatio = calculateContrastRatio(accentRgb, effectiveBgRgb);
    const eyebrowEval = evaluateContrast(eyebrowRatio, true);
    elements.push({
      element: "eyebrow",
      label: "Chamada Superior",
      foregroundHex: params.accentColor,
      backgroundHex: effectiveBgHex,
      ratio: eyebrowRatio,
      formattedRatio: `${eyebrowRatio.toFixed(1)}:1`,
      status: eyebrowEval.status,
      statusLabel: eyebrowEval.statusLabel,
      explanation: eyebrowEval.explanation,
    });
  }

  // 4. Botão de CTA: texto (backgroundColor) sobre fundo do botão (accentColor)
  if (params.showCallToAction !== false) {
    const ctaRatio = calculateContrastRatio(baseRgb, accentRgb);
    const ctaEval = evaluateContrast(ctaRatio, true);
    elements.push({
      element: "callToAction",
      label: "Chamada para Ação (CTA)",
      foregroundHex: params.backgroundColor,
      backgroundHex: params.accentColor,
      ratio: ctaRatio,
      formattedRatio: `${ctaRatio.toFixed(1)}:1`,
      status: ctaEval.status,
      statusLabel: ctaEval.statusLabel,
      explanation: `Contraste do texto do botão sobre o fundo de destaque (${ctaRatio.toFixed(1)}:1). ${ctaEval.explanation}`,
    });
  }

  const hasWarning = elements.some((e) => e.status === "WARNING");
  const hasFailure = elements.some((e) => e.status === "FAILED");

  return {
    effectiveBackgroundHex: effectiveBgHex,
    isBackgroundEstimated: Boolean(params.hasBackgroundImage),
    hasWarning,
    hasFailure,
    elements,
  };
}
