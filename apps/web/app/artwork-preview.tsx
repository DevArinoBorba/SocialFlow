"use client";

import React from "react";
import type { DesignFormat, DesignTemplateSpec } from "@socialflow/contracts";

export interface ArtworkPreviewProps {
  spec: DesignTemplateSpec;
  format?: DesignFormat;
  title?: string;
  eyebrow?: string;
  subtitle?: string;
  callToAction?: string;
  backgroundImageUrl?: string | null;
  logoImageUrl?: string | null;
  showSafeAreaGuides?: boolean;
  maxWidth?: number | string;
}

export const FORMAT_DETAILS: Record<
  DesignFormat,
  {
    label: string;
    dimensions: string;
    ratio: string;
    width: number;
    height: number;
  }
> = {
  SQUARE: {
    label: "Quadrado (Feed)",
    dimensions: "1080 × 1080 px",
    ratio: "1 / 1",
    width: 1080,
    height: 1080,
  },
  PORTRAIT: {
    label: "Retrato (Feed Vertical)",
    dimensions: "1080 × 1350 px",
    ratio: "4 / 5",
    width: 1080,
    height: 1350,
  },
  STORY: {
    label: "Story / Reels (Vertical Cheio)",
    dimensions: "1080 × 1920 px",
    ratio: "9 / 16",
    width: 1080,
    height: 1920,
  },
};

/**
 * ArtworkPreview
 *
 * Componente compartilhado e seguro de prévia de artes e templates de design.
 * Renderiza exclusivamente nós de texto React comuns (sem dangerouslySetInnerHTML,
 * sem interpolação de strings não sanitizadas em regras de estilo) e respeita
 * rigorosamente o layout determinístico utilizado pelo renderizador do worker (Satori/Sharp).
 */
export function ArtworkPreview({
  spec,
  format: propFormat,
  title = "Título da sua arte",
  eyebrow = "",
  subtitle = "",
  callToAction = "",
  backgroundImageUrl = null,
  logoImageUrl = null,
  showSafeAreaGuides = false,
  maxWidth = "360px",
}: ArtworkPreviewProps) {
  const format = propFormat ?? spec.format ?? "SQUARE";
  const formatInfo = FORMAT_DETAILS[format] ?? FORMAT_DETAILS.SQUARE;

  // Alinhamento horizontal alinhado com o renderizador (flex-start, center, flex-end)
  const alignItems =
    spec.textAlign === "center"
      ? "center"
      : spec.textAlign === "right"
        ? "flex-end"
        : "flex-start";

  // Percentual de safeArea calculado em relação à largura base (1080px)
  const safeAreaPercent = Math.max(
    3.7,
    Math.min(22.2, ((spec.safeArea ?? 80) / 1080) * 100),
  );

  return (
    <div
      className="preview-viewport-wrapper"
      style={{
        aspectRatio: formatInfo.ratio,
        maxWidth: typeof maxWidth === "number" ? `${maxWidth}px` : maxWidth,
      }}
      data-testid="artwork-preview-viewport"
    >
      <div
        className="preview-artboard"
        style={{
          backgroundColor: spec.backgroundColor ?? "#0F172A",
          padding: `${safeAreaPercent}%`,
          alignItems,
        }}
      >
        {/* Guia visual de safe area (quando ativada no editor) */}
        {showSafeAreaGuides && (
          <div
            className="preview-safe-area-guide"
            style={{
              inset: `${safeAreaPercent}%`,
            }}
            aria-hidden="true"
            title={`Área de segurança: ${spec.safeArea}px (${safeAreaPercent.toFixed(1)}%)`}
          />
        )}

        {/* Camada 1: Imagem de Fundo (se informada) */}
        {backgroundImageUrl && (
          <img
            src={backgroundImageUrl}
            alt=""
            className="preview-bg-layer"
            style={{ objectFit: "cover" }}
          />
        )}

        {/* Camada 2: Sobreposição com Cor e Opacidade Sanitizadas do Spec */}
        <div
          className="preview-overlay-layer"
          style={{
            backgroundColor: spec.overlayColor ?? "#000000",
            opacity: Math.max(0, Math.min(1, spec.overlayOpacity ?? 0.3)),
          }}
        />

        {/* Camada 3: Conteúdo Textual Seguro */}
        <div
          className="preview-content-layer"
          style={{
            textAlign: spec.textAlign ?? "left",
            alignItems,
          }}
        >
          {/* Logotipo (topo) */}
          {logoImageUrl && (
            <div className="preview-logo-top-container">
              <img
                src={logoImageUrl}
                alt=""
                className="preview-logo-image"
                style={{ objectFit: "contain" }}
              />
            </div>
          )}

          {/* Chamada Superior / Eyebrow */}
          {spec.showEyebrow && eyebrow.trim() && (
            <div
              className="preview-eyebrow"
              style={{
                color: spec.accentColor ?? "#E9C46A",
              }}
            >
              {eyebrow}
            </div>
          )}

          {/* Título Principal */}
          <h3
            className="preview-title"
            style={{
              color: spec.textColor ?? "#FFFFFF",
              WebkitLineClamp: spec.titleMaxLines ?? 3,
            }}
          >
            {title.trim() || "Título da sua arte"}
          </h3>

          {/* Subtítulo / Texto Complementar */}
          {spec.showSubtitle && subtitle.trim() && (
            <p
              className="preview-subtitle"
              style={{
                color: spec.mutedTextColor ?? "#94A3B8",
              }}
            >
              {subtitle}
            </p>
          )}

          {/* Botão de Chamada para Ação (CTA) */}
          {spec.showCallToAction && callToAction.trim() && (
            <div
              className="preview-cta-badge"
              style={{
                backgroundColor: spec.accentColor ?? "#E9C46A",
                color: spec.backgroundColor ?? "#0F172A",
                alignSelf: alignItems,
              }}
            >
              {callToAction}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
