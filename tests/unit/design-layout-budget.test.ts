import { describe, it, expect } from "vitest";
import type { DesignTemplateSpec } from "../../packages/contracts/src/design.js";
import { calculateLayoutBudget } from "../../packages/contracts/src/design.js";

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

describe("design-layout-budget: Análise Determinística de Orçamento Vertical", () => {
  it("calcula área útil e dimensões para o formato SQUARE (1080x1080)", () => {
    const budget = calculateLayoutBudget(BASE_SPEC);
    expect(budget.totalHeight).toBe(1080);
    expect(budget.safeAreaTotal).toBe(160); // 80 * 2
    expect(budget.availableHeight).toBe(920); // 1080 - 160
    expect(budget.usedHeight).toBeGreaterThan(0);
    expect(budget.remainingHeight).toBe(920 - budget.usedHeight);
  });

  it("calcula dimensões para PORTRAIT (1080x1350) e STORY (1080x1920)", () => {
    const portraitBudget = calculateLayoutBudget({
      ...BASE_SPEC,
      format: "PORTRAIT",
    });
    expect(portraitBudget.totalHeight).toBe(1350);
    expect(portraitBudget.availableHeight).toBe(1350 - 160);

    const storyBudget = calculateLayoutBudget({
      ...BASE_SPEC,
      format: "STORY",
    });
    expect(storyBudget.totalHeight).toBe(1920);
    expect(storyBudget.availableHeight).toBe(1920 - 160);
  });

  it("avalia cenários de texto curto, médio e limite progressivamente", () => {
    const shortBudget = calculateLayoutBudget(BASE_SPEC, {
      textScenario: "short",
    });
    const mediumBudget = calculateLayoutBudget(BASE_SPEC, {
      textScenario: "medium",
    });
    const limitBudget = calculateLayoutBudget(BASE_SPEC, {
      textScenario: "limit",
    });

    // Cenário curto consome menos altura que médio, que consome menos que limite
    expect(shortBudget.usedHeight).toBeLessThan(mediumBudget.usedHeight);
    expect(mediumBudget.usedHeight).toBeLessThan(limitBudget.usedHeight);

    // No cenário curto em SQUARE (safeArea 80), o status deve ser seguro
    expect(shortBudget.status).toBe("safe");
  });

  it("calcula o efeito do logotipo no consumo de espaço", () => {
    const withoutLogo = calculateLayoutBudget(BASE_SPEC, { hasLogo: false });
    const withLogo = calculateLayoutBudget(BASE_SPEC, { hasLogo: true });

    // Logo consome 90px de altura + 32px de margem inferior = 122px
    expect(withLogo.usedHeight - withoutLogo.usedHeight).toBe(122);
    expect(withLogo.blockBreakdown.some((b) => b.block === "Logotipo")).toBe(
      true,
    );
  });

  it("calcula o efeito do aumento da safe area na área disponível", () => {
    const safeArea80 = calculateLayoutBudget({ ...BASE_SPEC, safeArea: 80 });
    const safeArea180 = calculateLayoutBudget({ ...BASE_SPEC, safeArea: 180 });

    expect(safeArea80.availableHeight).toBe(1080 - 160); // 920
    expect(safeArea180.availableHeight).toBe(1080 - 360); // 720
    expect(safeArea180.remainingHeight).toBeLessThan(
      safeArea80.remainingHeight,
    );
  });

  it("calcula o efeito de titleMaxLines no cenário limite", () => {
    const max1Line = calculateLayoutBudget(
      { ...BASE_SPEC, titleMaxLines: 1 },
      { textScenario: "limit" },
    );
    const max4Lines = calculateLayoutBudget(
      { ...BASE_SPEC, titleMaxLines: 4 },
      { textScenario: "limit" },
    );

    expect(max1Line.usedHeight).toBeLessThan(max4Lines.usedHeight);
  });

  it("detecta risco de corte (overflow) em situações extremas", () => {
    // Formato quadrado com safeArea muito alta (220px = 440px perdidos), 4 linhas de título, logo, todos os blocos no limite
    const extremeSpec: DesignTemplateSpec = {
      ...BASE_SPEC,
      safeArea: 220,
      titleMaxLines: 4,
    };

    const budget = calculateLayoutBudget(extremeSpec, {
      textScenario: "limit",
      hasLogo: true,
    });

    expect(budget.status).toBe("overflow");
    expect(budget.remainingHeight).toBeLessThan(0);
    expect(budget.responsibleBlocks.length).toBeGreaterThan(0);
  });
});
