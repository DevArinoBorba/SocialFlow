import { describe, it, expect } from "vitest";
import {
  hexToRgb,
  rgbToHex,
  blendColors,
  calculateRelativeLuminance,
  calculateContrastRatio,
  evaluateWcagLevel,
  evaluateContrast,
  analyzeTemplateContrast,
} from "../../apps/web/app/design-contrast.js";

describe("design-contrast: Cálculo e Análise de Contraste WCAG 2.1", () => {
  it("converte hex para RGB e vice-versa corretamente", () => {
    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb("#FFFFFF")).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb("#0F172A")).toEqual({ r: 15, g: 23, b: 42 });
    expect(hexToRgb("invalido")).toBeNull();

    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
    expect(rgbToHex({ r: 255, g: 255, b: 255 })).toBe("#FFFFFF");
    expect(rgbToHex({ r: 15, g: 23, b: 42 })).toBe("#0F172A");
  });

  it("calcula luminância relativa exata para extremos preto e branco", () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    expect(calculateRelativeLuminance(black)).toBe(0);
    expect(calculateRelativeLuminance(white)).toBe(1);
  });

  it("calcula a razão de contraste teórica máxima 21:1 entre preto e branco", () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    expect(calculateContrastRatio(white, black)).toBe(21);
    expect(calculateContrastRatio(black, white)).toBe(21);
  });

  it("calcula a razão de contraste 1:1 entre duas cores idênticas", () => {
    const color = { r: 120, g: 120, b: 120 };
    expect(calculateContrastRatio(color, color)).toBe(1);
  });

  it("aplica composição alfa (alpha blending) corretamente", () => {
    const base = { r: 100, g: 100, b: 100 };
    const overlay = { r: 200, g: 200, b: 200 };
    // Com 0% de opacidade, o resultado deve ser a base
    expect(blendColors(base, overlay, 0)).toEqual(base);
    // Com 100% de opacidade, o resultado deve ser o overlay
    expect(blendColors(base, overlay, 1)).toEqual(overlay);
    // Com 50% de opacidade: 200 * 0.5 + 100 * 0.5 = 150
    expect(blendColors(base, overlay, 0.5)).toEqual({ r: 150, g: 150, b: 150 });
  });

  it("avalia níveis WCAG rigorosamente nos limites para texto normal", () => {
    // Normal: AA >= 4.5, AAA >= 7.0
    expect(evaluateWcagLevel(2.99, "normal")).toBe("FAIL");
    expect(evaluateWcagLevel(4.49, "normal")).toBe("FAIL");
    expect(evaluateWcagLevel(4.5, "normal")).toBe("AA");
    expect(evaluateWcagLevel(6.99, "normal")).toBe("AA");
    expect(evaluateWcagLevel(7.0, "normal")).toBe("AAA");
    expect(evaluateWcagLevel(12.0, "normal")).toBe("AAA");
  });

  it("avalia níveis WCAG rigorosamente nos limites para texto grande", () => {
    // Grande: AA >= 3.0, AAA >= 4.5
    expect(evaluateWcagLevel(2.99, "large")).toBe("FAIL");
    expect(evaluateWcagLevel(3.0, "large")).toBe("AA");
    expect(evaluateWcagLevel(4.49, "large")).toBe("AA");
    expect(evaluateWcagLevel(4.5, "large")).toBe("AAA");
    expect(evaluateWcagLevel(7.0, "large")).toBe("AAA");
  });

  it("classifica o status de contraste (APPROVED, WARNING, FAILED)", () => {
    // Texto grande com AAA (>= 4.5) -> APPROVED
    expect(evaluateContrast(5.0, "large").status).toBe("APPROVED");
    expect(evaluateContrast(5.0, "large").wcagLevel).toBe("AAA");

    // Texto grande com AA (3.0 a 4.5) -> APPROVED (atende nível AA para texto grande)
    expect(evaluateContrast(3.5, "large").status).toBe("APPROVED");
    expect(evaluateContrast(3.5, "large").wcagLevel).toBe("AA");

    // Texto grande abaixo de AA (< 3.0) -> FAILED
    expect(evaluateContrast(2.5, "large").status).toBe("FAILED");
    expect(evaluateContrast(2.5, "large").wcagLevel).toBe("FAIL");

    // Texto normal com AAA (>= 7.0) -> APPROVED
    expect(evaluateContrast(7.5, "normal").status).toBe("APPROVED");
    expect(evaluateContrast(7.5, "normal").wcagLevel).toBe("AAA");

    // Texto normal com AA (4.5 a 7.0) -> APPROVED
    expect(evaluateContrast(5.0, "normal").status).toBe("APPROVED");
    expect(evaluateContrast(5.0, "normal").wcagLevel).toBe("AA");

    // Texto normal entre 3.0 e 4.5 -> WARNING (aceitável para grande, reprovado para normal)
    expect(evaluateContrast(3.5, "normal").status).toBe("WARNING");
    expect(evaluateContrast(3.5, "normal").wcagLevel).toBe("FAIL");

    // Texto normal abaixo de 3.0 -> FAILED
    expect(evaluateContrast(2.5, "normal").status).toBe("FAILED");
    expect(evaluateContrast(2.5, "normal").wcagLevel).toBe("FAIL");
  });

  it("analisa especificação com alto contraste (Editorial Dark)", () => {
    const analysis = analyzeTemplateContrast({
      backgroundColor: "#0F172A",
      overlayColor: "#020617",
      overlayOpacity: 0.3,
      textColor: "#F8FAFC",
      mutedTextColor: "#94A3B8",
      accentColor: "#38BDF8",
      showEyebrow: true,
      showSubtitle: true,
      showCallToAction: true,
    });

    expect(analysis.isBackgroundEstimated).toBe(false);
    expect(analysis.hasFailure).toBe(false);

    const titleResult = analysis.elements.find((e) => e.element === "title");
    expect(titleResult).toBeDefined();
    expect(titleResult?.category).toBe("large");
    expect(titleResult?.wcagLevel).toBe("AAA");
    expect(titleResult?.status).toBe("APPROVED");
    expect(titleResult?.ratio).toBeGreaterThanOrEqual(10);

    const eyebrowResult = analysis.elements.find(
      (e) => e.element === "eyebrow",
    );
    expect(eyebrowResult).toBeDefined();
    expect(eyebrowResult?.category).toBe("large");
    expect(eyebrowResult?.wcagLevel).toBe("AAA");

    const ctaResult = analysis.elements.find(
      (e) => e.element === "callToAction",
    );
    expect(ctaResult).toBeDefined();
    expect(ctaResult?.category).toBe("large");
    // CTA: texto escuro #0F172A sobre botão azul #38BDF8
    expect(ctaResult?.ratio).toBeGreaterThanOrEqual(4.5);
    expect(ctaResult?.status).toBe("APPROVED");
  });

  it("detecta reprovação em combinações de cores com baixo contraste", () => {
    const analysis = analyzeTemplateContrast({
      backgroundColor: "#202020",
      overlayColor: "#000000",
      overlayOpacity: 0.1,
      textColor: "#333333", // Cinza escuro sobre preto
      mutedTextColor: "#444444",
      accentColor: "#555555",
      showEyebrow: true,
      showSubtitle: true,
      showCallToAction: true,
    });

    expect(analysis.hasFailure).toBe(true);
    expect(analysis.failedElements.length).toBeGreaterThan(0);
    const titleResult = analysis.elements.find((e) => e.element === "title");
    expect(titleResult?.status).toBe("FAILED");
    expect(titleResult?.wcagLevel).toBe("FAIL");
    expect(titleResult?.ratio).toBeLessThan(3.0);
  });

  it("calcula contraste de CTA entre o texto (backgroundColor) e botão (accentColor)", () => {
    const analysis = analyzeTemplateContrast({
      backgroundColor: "#000000", // Texto do botão
      overlayColor: "#000000",
      overlayOpacity: 0,
      textColor: "#FFFFFF",
      mutedTextColor: "#CCCCCC",
      accentColor: "#FFFFFF", // Fundo do botão branco
      showCallToAction: true,
    });

    const ctaResult = analysis.elements.find(
      (e) => e.element === "callToAction",
    );
    expect(ctaResult).toBeDefined();
    expect(ctaResult?.ratio).toBe(21); // Branco com preto = 21:1
    expect(ctaResult?.wcagLevel).toBe("AAA");
    expect(ctaResult?.status).toBe("APPROVED");
  });

  it("marca flag de estimativa quando houver imagem de fundo", () => {
    const analysis = analyzeTemplateContrast({
      backgroundColor: "#0F172A",
      overlayColor: "#020617",
      overlayOpacity: 0.3,
      textColor: "#FFFFFF",
      mutedTextColor: "#94A3B8",
      accentColor: "#38BDF8",
      hasBackgroundImage: true,
    });

    expect(analysis.isBackgroundEstimated).toBe(true);
  });
});
