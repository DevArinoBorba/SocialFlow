import type { DesignTemplateSpec } from "@socialflow/contracts";

export interface TemplateDifference {
  property: keyof DesignTemplateSpec;
  label: string;
  before: string;
  after: string;
  beforeDescription: string;
  afterDescription: string;
}

export type TemplateDifferenceItem = TemplateDifference;

const FORMAT_LABELS: Record<string, string> = {
  SQUARE: "Quadrado (1080 × 1080 px)",
  PORTRAIT: "Retrato (1080 × 1350 px)",
  STORY: "Story / Reels (1080 × 1920 px)",
};

const ALIGN_LABELS: Record<string, string> = {
  left: "À esquerda",
  center: "Centralizado",
  right: "À direita",
};

/**
 * Compara recursivamente e deterministicamente dois objetos ou especificações,
 * ignorando a ordem acidental das chaves JSON.
 */
export function areSpecsEqual(
  a: DesignTemplateSpec | null | undefined,
  b: DesignTemplateSpec | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;

  const keys: Array<keyof DesignTemplateSpec> = [
    "schemaVersion",
    "format",
    "backgroundColor",
    "overlayColor",
    "overlayOpacity",
    "textColor",
    "mutedTextColor",
    "accentColor",
    "safeArea",
    "textAlign",
    "titleMaxLines",
    "showEyebrow",
    "showSubtitle",
    "showCallToAction",
  ];

  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Retorna uma lista estruturada e legível em português de todas as diferenças
 * entre duas especificações de template.
 */
export function describeTemplateDifferences(
  before: DesignTemplateSpec,
  after: DesignTemplateSpec,
): TemplateDifference[] {
  const diffs: TemplateDifference[] = [];

  function addDiff(
    property: keyof DesignTemplateSpec,
    label: string,
    beforeVal: string,
    afterVal: string,
  ) {
    diffs.push({
      property,
      label,
      before: beforeVal,
      after: afterVal,
      beforeDescription: beforeVal,
      afterDescription: afterVal,
    });
  }

  if (before.format !== after.format) {
    addDiff(
      "format",
      "Formato",
      FORMAT_LABELS[before.format] ?? before.format,
      FORMAT_LABELS[after.format] ?? after.format,
    );
  }

  if (
    before.backgroundColor.toLowerCase() !== after.backgroundColor.toLowerCase()
  ) {
    addDiff(
      "backgroundColor",
      "Cor de fundo",
      before.backgroundColor.toUpperCase(),
      after.backgroundColor.toUpperCase(),
    );
  }

  if (before.overlayColor.toLowerCase() !== after.overlayColor.toLowerCase()) {
    addDiff(
      "overlayColor",
      "Cor de sobreposição",
      before.overlayColor.toUpperCase(),
      after.overlayColor.toUpperCase(),
    );
  }

  if (before.overlayOpacity !== after.overlayOpacity) {
    addDiff(
      "overlayOpacity",
      "Opacidade da sobreposição",
      `${Math.round(before.overlayOpacity * 100)}%`,
      `${Math.round(after.overlayOpacity * 100)}%`,
    );
  }

  if (before.textColor.toLowerCase() !== after.textColor.toLowerCase()) {
    addDiff(
      "textColor",
      "Cor principal do texto",
      before.textColor.toUpperCase(),
      after.textColor.toUpperCase(),
    );
  }

  if (
    before.mutedTextColor.toLowerCase() !== after.mutedTextColor.toLowerCase()
  ) {
    addDiff(
      "mutedTextColor",
      "Cor do subtítulo (secundária)",
      before.mutedTextColor.toUpperCase(),
      after.mutedTextColor.toUpperCase(),
    );
  }

  if (before.accentColor.toLowerCase() !== after.accentColor.toLowerCase()) {
    addDiff(
      "accentColor",
      "Cor de destaque (accent)",
      before.accentColor.toUpperCase(),
      after.accentColor.toUpperCase(),
    );
  }

  if (before.safeArea !== after.safeArea) {
    addDiff(
      "safeArea",
      "Área de segurança (safeArea)",
      `${before.safeArea}px`,
      `${after.safeArea}px`,
    );
  }

  if (before.textAlign !== after.textAlign) {
    addDiff(
      "textAlign",
      "Alinhamento do texto",
      ALIGN_LABELS[before.textAlign] ?? before.textAlign,
      ALIGN_LABELS[after.textAlign] ?? after.textAlign,
    );
  }

  if (before.titleMaxLines !== after.titleMaxLines) {
    addDiff(
      "titleMaxLines",
      "Limite de linhas do título",
      `${before.titleMaxLines} linha(s)`,
      `${after.titleMaxLines} linha(s)`,
    );
  }

  if (before.showEyebrow !== after.showEyebrow) {
    addDiff(
      "showEyebrow",
      "Exibir chamada superior (eyebrow)",
      before.showEyebrow ? "Visível" : "Oculto",
      after.showEyebrow ? "Visível" : "Oculto",
    );
  }

  if (before.showSubtitle !== after.showSubtitle) {
    addDiff(
      "showSubtitle",
      "Exibir subtítulo",
      before.showSubtitle ? "Visível" : "Oculto",
      after.showSubtitle ? "Visível" : "Oculto",
    );
  }

  if (before.showCallToAction !== after.showCallToAction) {
    addDiff(
      "showCallToAction",
      "Exibir chamada para ação (CTA)",
      before.showCallToAction ? "Visível" : "Oculto",
      after.showCallToAction ? "Visível" : "Oculto",
    );
  }

  return diffs;
}
