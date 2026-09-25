"use client";

import { useEffect, useState } from "react";
import type {
  Brand,
  Client,
  CurrentUser,
  RenderBatchDto,
} from "@socialflow/contracts";

interface DashboardSummaryProps {
  org: string;
  client: Client;
  brands: Brand[];
  me: CurrentUser;
  canWrite: boolean;
  canApprove: boolean;
  canGenerate: boolean;
  onNavigate: (
    sectionId: "conteudo" | "artes" | "biblioteca" | "configuracoes",
  ) => void;
}

export function DashboardSummary({
  org,
  client,
  brands,
  me,
  canWrite,
  canApprove,
  canGenerate,
  onNavigate,
}: DashboardSummaryProps) {
  const [pendingPostsCount, setPendingPostsCount] = useState<number | null>(
    null,
  );
  const [activeBatches, setActiveBatches] = useState<RenderBatchDto[]>([]);
  const [mediaCount, setMediaCount] = useState<number | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);

  useEffect(() => {
    let active = true;
    setLoadingSummary(true);

    const postsUrl = `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(client.id)}/posts?status=IN_REVIEW`;
    const batchesUrl = `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(client.id)}/render-batches?limit=5`;
    const mediaUrl = `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(client.id)}/media?limit=1`;

    Promise.allSettled([
      fetch(postsUrl).then((r) => (r.ok ? r.json() : [])),
      fetch(batchesUrl).then((r) => (r.ok ? r.json() : { batches: [] })),
      fetch(mediaUrl).then((r) => (r.ok ? r.json() : { items: [] })),
    ]).then(([postsRes, batchesRes, mediaRes]) => {
      if (!active) return;
      if (postsRes.status === "fulfilled" && Array.isArray(postsRes.value)) {
        setPendingPostsCount(postsRes.value.length);
      }
      if (batchesRes.status === "fulfilled" && batchesRes.value?.batches) {
        const inProgress = batchesRes.value.batches.filter(
          (b: RenderBatchDto) =>
            b.status === "PENDING" ||
            b.status === "PROCESSING" ||
            b.status === "CANCELLING",
        );
        setActiveBatches(inProgress);
      }
      if (mediaRes.status === "fulfilled" && mediaRes.value?.items) {
        setMediaCount(mediaRes.value.items.length);
      }
      setLoadingSummary(false);
    });

    return () => {
      active = false;
    };
  }, [org, client.id]);

  return (
    <section
      id="inicio"
      className="dashboard-summary-panel"
      aria-label="Visão Geral do Cliente"
    >
      <div className="dashboard-banner">
        <div>
          <h2>Visão Operacional</h2>
          <p className="muted">
            Acompanhamento em tempo real para <strong>{client.name}</strong> •
            Sessão ativa de <strong>{me.user.name}</strong>.
          </p>
        </div>
        <div className="dashboard-quick-actions">
          {canWrite && (
            <button
              type="button"
              className="action-btn-primary"
              onClick={() => onNavigate("conteudo")}
            >
              + Novo post
            </button>
          )}
          {canGenerate && (
            <button
              type="button"
              className="action-btn-secondary"
              onClick={() => onNavigate("artes")}
            >
              Gerar artes
            </button>
          )}
          <button
            type="button"
            className="action-btn-quiet"
            onClick={() => onNavigate("biblioteca")}
          >
            Biblioteca
          </button>
        </div>
      </div>

      <div className="dashboard-kpi-grid">
        {/* 1. Posts Aguardando Aprovação */}
        <article className="kpi-card">
          <div className="kpi-header">
            <span className="kpi-icon">📝</span>
            <span className="kpi-tag">Aprovação</span>
          </div>
          <h3>Posts em Revisão</h3>
          <div className="kpi-value-row">
            <span className="kpi-number">
              {loadingSummary ? "…" : (pendingPostsCount ?? 0)}
            </span>
            <span className="kpi-subtext">
              {pendingPostsCount === 1
                ? "publicação pendente"
                : "publicações pendentes"}
            </span>
          </div>
          <p className="kpi-description">
            {pendingPostsCount && pendingPostsCount > 0
              ? `${pendingPostsCount} post(s) aguardando revisão para agendamento.`
              : "Nenhum post aguardando aprovação no momento."}
          </p>
          <button
            type="button"
            className="quiet kpi-action-link"
            onClick={() => onNavigate("conteudo")}
          >
            {canApprove ? "Revisar posts pendentes →" : "Ver posts →"}
          </button>
        </article>

        {/* 2. Lotes de Artes em Andamento */}
        <article className="kpi-card">
          <div className="kpi-header">
            <span className="kpi-icon">🎨</span>
            <span className="kpi-tag">Renderização</span>
          </div>
          <h3>Lotes em Andamento</h3>
          <div className="kpi-value-row">
            <span className="kpi-number">
              {loadingSummary ? "…" : activeBatches.length}
            </span>
            <span className="kpi-subtext">
              {activeBatches.length === 1 ? "lote ativo" : "lotes ativos"}
            </span>
          </div>
          <p className="kpi-description">
            {activeBatches.length > 0
              ? `${activeBatches.length} lote(s) sendo processados na fila segura.`
              : "Nenhum lote de artes em execução no momento."}
          </p>
          <button
            type="button"
            className="quiet kpi-action-link"
            onClick={() => onNavigate("artes")}
          >
            Gerenciador de artes e lotes →
          </button>
        </article>

        {/* 3. Biblioteca e Mídias */}
        <article className="kpi-card">
          <div className="kpi-header">
            <span className="kpi-icon">🖼️</span>
            <span className="kpi-tag">Acervo</span>
          </div>
          <h3>Biblioteca de Mídias</h3>
          <div className="kpi-value-row">
            <span className="kpi-number">
              {loadingSummary ? "…" : (mediaCount ?? 0)}
            </span>
            <span className="kpi-subtext">imagens no acervo</span>
          </div>
          <p className="kpi-description">
            Imagens validadas prontas para composição de layouts e publicações.
          </p>
          <button
            type="button"
            className="quiet kpi-action-link"
            onClick={() => onNavigate("biblioteca")}
          >
            Explorar biblioteca de imagens →
          </button>
        </article>

        {/* 4. Marcas e Configurações */}
        <article className="kpi-card">
          <div className="kpi-header">
            <span className="kpi-icon">⚙️</span>
            <span className="kpi-tag">Estrutura</span>
          </div>
          <h3>Marcas & Redes</h3>
          <div className="kpi-value-row">
            <span className="kpi-number">{brands.length}</span>
            <span className="kpi-subtext">
              {brands.length === 1 ? "marca cadastrada" : "marcas cadastradas"}
            </span>
          </div>
          <p className="kpi-description">
            {brands.length === 0
              ? "Cadastre a primeira marca para personalizar estilos e legendas."
              : `Ativo com ${brands.length} marca(s) e canais de publicação.`}
          </p>
          <button
            type="button"
            className="quiet kpi-action-link"
            onClick={() => onNavigate("configuracoes")}
          >
            Gerenciar marcas e conexões →
          </button>
        </article>
      </div>
    </section>
  );
}
