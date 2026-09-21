import { describe, it, expect } from "vitest";
import {
  hexToRgb,
  rgbToHex,
  blendColors,
  calculateRelativeLuminance,
  calculateContrastRatio,
  evaluateContrast,
  analyzeTemplateContrast,
} from "../../apps/web/app/design-contrast.js";

describe("design-contrast: Cálculo e Análise de Contraste WCAG 2.1", () => {
  it("converte hex para RGB e vice-versa corretamente", () => {
    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb("#FFFFFF")).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb("#0F172A")).toEqual({ r: 15, g: 23, b: 42 });
    expect(hexToRgb("inválido")).toBeNull();

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

  it("classifica o contraste de acordo com os limiares WCAG", () => {
    // >= 4.5: Aprovado
    expect(evaluateContrast(7.5, false).status).toBe("APPROVED");
    expect(evaluateContrast(4.5, false).status).toBe("APPROVED");

    // Entre 3.0 e 4.5
    // Para texto grande: Aprovado
    expect(evaluateContrast(3.8, true).status).toBe("APPROVED");
    // Para texto normal: Atenção
    expect(evaluateContrast(3.8, false).status).toBe("WARNING");

    // < 3.0: Reprovado
    expect(evaluateContrast(2.2, true).status).toBe("FAILED");
    expect(evaluateContrast(1.5, false).status).toBe("FAILED");
  });

  it("analisa especificação de template com alto contraste (Editorial Dark)", () => {
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
    expect(titleResult?.status).toBe("APPROVED");
    expect(titleResult?.ratio).toBeGreaterThanOrEqual(10); // Branco sobre azul quase preto é altíssimo

    const eyebrowResult = analysis.elements.find(
      (e) => e.element === "eyebrow",
    );
    expect(eyebrowResult).toBeDefined();
    expect(eyebrowResult?.status).toBe("APPROVED");

    const ctaResult = analysis.elements.find(
      (e) => e.element === "callToAction",
    );
    expect(ctaResult).toBeDefined();
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
    const titleResult = analysis.elements.find((e) => e.element === "title");
    expect(titleResult?.status).toBe("FAILED");
    expect(titleResult?.ratio).toBeLessThan(3.0);
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
