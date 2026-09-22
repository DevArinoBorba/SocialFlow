import { describe, it, expect } from "vitest";
import type { DesignTemplateSpec } from "../../packages/contracts/src/design.js";
import {
  areSpecsEqual,
  describeTemplateDifferences,
} from "../../apps/web/app/design-diff.js";

const BASE_SPEC: DesignTemplateSpec = {
  schemaVersion: 1,
  format: "SQUARE",
  backgroundColor: "#0F172A",
  overlayColor: "#020617",
  overlayOpacity: 0.3,
  textColor: "#F8FAFC",
  mutedTextColor: "#94A3B8",
  accentColor: "#38BDF8",
  safeArea: 80,
  textAlign: "left",
  titleMaxLines: 3,
  showEyebrow: true,
  showSubtitle: true,
  showCallToAction: true,
};

describe("design-diff: Comparação e Resumo Legível de Especificações", () => {
  it("considera especificações idênticas mesmo com chaves em ordens diferentes", () => {
    const specA: DesignTemplateSpec = {
      schemaVersion: 1,
      format: "SQUARE",
      backgroundColor: "#0F172A",
      overlayColor: "#020617",
      overlayOpacity: 0.3,
      textColor: "#F8FAFC",
      mutedTextColor: "#94A3B8",
      accentColor: "#38BDF8",
      safeArea: 80,
      textAlign: "left",
      titleMaxLines: 3,
      showEyebrow: true,
      showSubtitle: true,
      showCallToAction: true,
    };

    // Objeto com as mesmas chaves e valores, mas em ordem invertida/alterada
    const specB = {
      showCallToAction: true,
      titleMaxLines: 3,
      safeArea: 80,
      textAlign: "left" as const,
      accentColor: "#38BDF8",
      mutedTextColor: "#94A3B8",
      textColor: "#F8FAFC",
      overlayOpacity: 0.3,
      overlayColor: "#020617",
      backgroundColor: "#0F172A",
      format: "SQUARE" as const,
      schemaVersion: 1 as const,
      showSubtitle: true,
      showEyebrow: true,
    } as DesignTemplateSpec;

    expect(areSpecsEqual(specA, specB)).toBe(true);
    expect(areSpecsEqual(specB, specA)).toBe(true);
    expect(describeTemplateDifferences(specA, specB)).toHaveLength(0);
  });

  it("detecta diferença de valor em propriedades numéricas e booleanas", () => {
    const modified: DesignTemplateSpec = {
      ...BASE_SPEC,
      safeArea: 100,
      showEyebrow: false,
      titleMaxLines: 2,
    };

    expect(areSpecsEqual(BASE_SPEC, modified)).toBe(false);

    const diffs = describeTemplateDifferences(BASE_SPEC, modified);
    expect(diffs).toHaveLength(3);

    const safeAreaDiff = diffs.find((d) => d.property === "safeArea");
    expect(safeAreaDiff).toBeDefined();
    expect(safeAreaDiff?.before).toBe("80px");
    expect(safeAreaDiff?.after).toBe("100px");

    const eyebrowDiff = diffs.find((d) => d.property === "showEyebrow");
    expect(eyebrowDiff).toBeDefined();
    expect(eyebrowDiff?.before).toBe("Visível");
    expect(eyebrowDiff?.after).toBe("Oculto");

    const linesDiff = diffs.find((d) => d.property === "titleMaxLines");
    expect(linesDiff).toBeDefined();
    expect(linesDiff?.before).toBe("3 linha(s)");
    expect(linesDiff?.after).toBe("2 linha(s)");
  });

  it("gera descrições legíveis para todas as propriedades configuráveis", () => {
    const altered: DesignTemplateSpec = {
      schemaVersion: 1,
      format: "STORY",
      backgroundColor: "#111827",
      overlayColor: "#000000",
      overlayOpacity: 0.5,
      textColor: "#FFFFFF",
      mutedTextColor: "#CBD5E1",
      accentColor: "#F59E0B",
      safeArea: 120,
      textAlign: "center",
      titleMaxLines: 1,
      showEyebrow: false,
      showSubtitle: false,
      showCallToAction: false,
    };

    const diffs = describeTemplateDifferences(BASE_SPEC, altered);

    const properties = diffs.map((d) => d.property);
    expect(properties).toContain("format");
    expect(properties).toContain("backgroundColor");
    expect(properties).toContain("overlayColor");
    expect(properties).toContain("overlayOpacity");
    expect(properties).toContain("textColor");
    expect(properties).toContain("mutedTextColor");
    expect(properties).toContain("accentColor");
    expect(properties).toContain("safeArea");
    expect(properties).toContain("textAlign");
    expect(properties).toContain("titleMaxLines");
    expect(properties).toContain("showEyebrow");
    expect(properties).toContain("showSubtitle");
    expect(properties).toContain("showCallToAction");

    const formatDiff = diffs.find((d) => d.property === "format");
    expect(formatDiff?.before).toContain("Quadrado");
    expect(formatDiff?.after).toContain("Story");

    const alignDiff = diffs.find((d) => d.property === "textAlign");
    expect(alignDiff?.before).toBe("À esquerda");
    expect(alignDiff?.after).toBe("Centralizado");
  });

  it("retorna lista vazia quando as especificações forem iguais", () => {
    const diffs = describeTemplateDifferences(BASE_SPEC, { ...BASE_SPEC });
    expect(diffs).toEqual([]);
  });
});
