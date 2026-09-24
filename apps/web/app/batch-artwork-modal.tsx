"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  type DesignFormat,
  type Post,
  type RenderBatchDto,
  type RenderBatchItemDto,
  type RenderBatchValidateResult,
  type RenderBatchListResponse,
  isRenderBatchListResponse,
} from "@socialflow/contracts";
import { BatchPollingController } from "./batch-polling-controller";

interface DesignTemplateVersionSummary {
  id: string;
  version: number;
  format: DesignFormat;
  specHash: string;
  rendererVersion: string;
  createdAt: string;
}

interface DesignTemplateListItem {
  id: string;
  name: string;
  systemKey: string | null;
  status: "ACTIVE" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
  latestVersion: DesignTemplateVersionSummary | null;
}

interface BatchArtworkModalProps {
  isOpen: boolean;
  onClose: () => void;
  org: string;
  clientId: string;
  selectedPosts: Post[];
  onArtworkBatchCompleted?: () => void;
}

const FORMAT_METADATA: Record<
  DesignFormat,
  { label: string; dimensions: string; ratio: string }
> = {
  SQUARE: {
    label: "Quadrado",
    dimensions: "1080 × 1080",
    ratio: "1:1",
  },
  PORTRAIT: {
    label: "Retrato",
    dimensions: "1080 × 1350",
    ratio: "4:5",
  },
  STORY: {
    label: "Story",
    dimensions: "1080 × 1920",
    ratio: "9:16",
  },
};

function formatBatchStatusLabel(status: RenderBatchDto["status"]): string {
  switch (status) {
    case "PENDING":
      return "Pendente";
    case "PROCESSING":
      return "Em processamento";
    case "CANCELLING":
      return "Cancelando...";
    case "COMPLETED":
      return "Concluído";
    case "PARTIALLY_FAILED":
      return "Concluído com falhas";
    case "FAILED":
      return "Falhou";
    case "CANCELLED":
      return "Cancelado";
    default:
      return status;
  }
}

function formatBatchStatusBadgeClass(status: RenderBatchDto["status"]): string {
  switch (status) {
    case "COMPLETED":
      return "badge-batch-completed";
    case "PARTIALLY_FAILED":
    case "CANCELLING":
      return "badge-batch-warning";
    case "PROCESSING":
      return "badge-batch-processing";
    case "PENDING":
      return "badge-batch-pending";
    case "CANCELLED":
      return "badge-batch-cancelled";
    case "FAILED":
      return "badge-batch-failed";
    default:
      return "badge-batch-pending";
  }
}

async function requestApi<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      data.message ?? "Não foi possível concluir a operação. Tente novamente.",
    );
  }
  return data as T;
}

export function BatchArtworkModal({
  isOpen,
  onClose,
  org,
  clientId,
  selectedPosts,
  onArtworkBatchCompleted,
}: BatchArtworkModalProps) {
  const idPrefix = useId();

  // Rotas base
  const templatesBase = `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}/design-templates`;
  const batchesBase = `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}/render-batches`;

  // Abas
  const [tab, setTab] = useState<"configure" | "progress" | "history">(
    "configure",
  );

  // Templates
  const [templates, setTemplates] = useState<DesignTemplateListItem[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [selectedFormat, setSelectedFormat] =
    useState<DesignFormat>("PORTRAIT");

  // Validação
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] =
    useState<RenderBatchValidateResult | null>(null);

  // Criação e Lote Ativo
  const [submitting, setSubmitting] = useState(false);
  const [activeBatch, setActiveBatch] = useState<RenderBatchDto | null>(null);
  const [batchItems, setBatchItems] = useState<RenderBatchItemDto[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);

  // Cancelamento
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Histórico
  const [historyBatches, setHistoryBatches] = useState<RenderBatchDto[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Mensagens
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");

  // Polling controller
  const pollingRef = useRef<BatchPollingController | null>(null);

  // Limpa polling ao desmontar
  useEffect(() => {
    return () => {
      pollingRef.current?.dispose();
    };
  }, []);

  // Fecha modal ao pressionar Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Carrega templates ao abrir modal
  useEffect(() => {
    if (!isOpen) return;

    let live = true;
    setLoadingTemplates(true);
    setError("");

    requestApi<{ items: DesignTemplateListItem[] }>(
      `${templatesBase}?status=ACTIVE&limit=50`,
    )
      .then((res) => {
        if (!live) return;
        setTemplates(res.items);
        if (res.items.length > 0 && !selectedTemplateId && res.items[0]) {
          setSelectedTemplateId(res.items[0].id);
        }
      })
      .catch((err) => {
        if (!live) return;
        setError(
          err instanceof Error ? err.message : "Erro ao carregar templates.",
        );
      })
      .finally(() => {
        if (live) setLoadingTemplates(false);
      });

    return () => {
      live = false;
    };
  }, [isOpen, templatesBase, selectedTemplateId]);

  // Carrega itens do lote ativo quando activeBatch muda
  const loadBatchItems = useCallback(
    async (batchId: string) => {
      try {
        setLoadingItems(true);
        const data = await requestApi<{ items: RenderBatchItemDto[] }>(
          `${batchesBase}/${encodeURIComponent(batchId)}/items?limit=100`,
        );
        setBatchItems(data.items);
      } catch {
        // Ignora erro transitório de itens
      } finally {
        setLoadingItems(false);
      }
    },
    [batchesBase],
  );

  // Inicia polling para um lote
  const startTrackingBatch = useCallback(
    (batch: RenderBatchDto) => {
      setActiveBatch(batch);
      setTab("progress");
      setConfirmingCancel(false);
      void loadBatchItems(batch.id);

      if (pollingRef.current) {
        pollingRef.current.dispose();
      }

      const controller = new BatchPollingController({
        fetchBatch: async (batchId, signal) => {
          return requestApi<RenderBatchDto>(
            `${batchesBase}/${encodeURIComponent(batchId)}`,
            { signal },
          );
        },
        onBatchUpdated: (updated) => {
          setActiveBatch(updated);
          void loadBatchItems(updated.id);
        },
        onBatchTerminal: (terminalBatch) => {
          setActiveBatch(terminalBatch);
          void loadBatchItems(terminalBatch.id);
          if (onArtworkBatchCompleted) {
            onArtworkBatchCompleted();
          }
        },
      });

      pollingRef.current = controller;
      controller.startPolling(batch.id);
    },
    [batchesBase, loadBatchItems, onArtworkBatchCompleted],
  );

  // Executa validação de pré-criação
  const handleValidate = async () => {
    if (!selectedTemplateId) {
      setError("Selecione um modelo de design antes de validar.");
      return;
    }

    const tpl = templates.find((t) => t.id === selectedTemplateId);
    if (!tpl || !tpl.latestVersion) {
      setError("O modelo selecionado não possui versão válida configurada.");
      return;
    }

    try {
      setValidating(true);
      setError("");
      setNotice("");

      const postIds = selectedPosts.map((p) => p.id);
      const res = await requestApi<RenderBatchValidateResult>(
        `${batchesBase}/validate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateVersionId: tpl.latestVersion.id,
            format: selectedFormat,
            source: {
              type: "POSTS_SELECTION",
              postIds,
            },
          }),
        },
      );

      setValidationResult(res);
      if (!res.valid) {
        setError(
          `Apenas ${res.validItemsCount} de ${res.totalRequested} posts são válidos para renderização. Verifique os erros abaixo.`,
        );
      } else {
        setNotice(
          `Todos os ${res.validItemsCount} posts selecionados são válidos e estão prontos para renderização.`,
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Erro ao validar lote de artes.",
      );
    } finally {
      setValidating(false);
    }
  };

  // Criação do Lote
  const handleStartBatch = async () => {
    if (!selectedTemplateId) {
      setError("Selecione um modelo de design.");
      return;
    }

    const tpl = templates.find((t) => t.id === selectedTemplateId);
    if (!tpl || !tpl.latestVersion) {
      setError("Modelo inválido.");
      return;
    }

    try {
      setSubmitting(true);
      setError("");
      setNotice("");

      // Geração de chave determinística/idempotente
      const idempotencyKey = `batch-${Date.now()}-${crypto.randomUUID()}`;

      const postIds = selectedPosts.map((p) => p.id);
      const createdBatch = await requestApi<RenderBatchDto>(batchesBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateVersionId: tpl.latestVersion.id,
          format: selectedFormat,
          source: {
            type: "POSTS_SELECTION",
            postIds,
          },
          idempotencyKey,
        }),
      });

      startTrackingBatch(createdBatch);
      setNotice("Lote de renderização iniciado com sucesso!");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Erro ao iniciar lote de renderização.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  // Repetição somente de itens falhos
  const handleRetryFailedBatch = async () => {
    if (!activeBatch) return;

    try {
      setSubmitting(true);
      setError("");
      setNotice("");

      const idempotencyKey = `retry-${activeBatch.id}-${Date.now()}`;
      const retriedBatch = await requestApi<RenderBatchDto>(
        `${batchesBase}/${encodeURIComponent(activeBatch.id)}/retry-failed`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idempotencyKey }),
        },
      );

      startTrackingBatch(retriedBatch);
      setNotice("Repetição dos itens falhos iniciada com sucesso!");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Erro ao repetir itens falhos do lote.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  // Cancelamento cooperativo
  const handleCancelBatch = async () => {
    if (!activeBatch) return;

    try {
      setCancelling(true);
      setError("");

      const cancelledBatch = await requestApi<RenderBatchDto>(
        `${batchesBase}/${encodeURIComponent(activeBatch.id)}/cancel`,
        { method: "POST" },
      );

      setActiveBatch(cancelledBatch);
      setConfirmingCancel(false);
      void loadBatchItems(cancelledBatch.id);
      setNotice("Cancelamento solicitado. Itens pendentes foram cancelados.");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Erro ao cancelar lote de renderização.",
      );
    } finally {
      setCancelling(false);
    }
  };

  // Carrega histórico de lotes
  const loadHistory = useCallback(
    async (signal?: { cancelled: boolean }) => {
      try {
        setLoadingHistory(true);
        setError("");
        const data = await requestApi<RenderBatchListResponse>(
          `${batchesBase}?limit=20`,
        );
        if (signal?.cancelled) return;
        if (!isRenderBatchListResponse(data)) {
          throw new Error(
            "Resposta inválida da API ao carregar o histórico de lotes.",
          );
        }
        setHistoryBatches(data.batches);
      } catch (err) {
        if (signal?.cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : "Erro ao carregar histórico de lotes.",
        );
      } finally {
        if (!signal?.cancelled) {
          setLoadingHistory(false);
        }
      }
    },
    [batchesBase],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    if (isOpen && tab === "history") {
      void loadHistory(signal);
    }
    return () => {
      signal.cancelled = true;
    };
  }, [isOpen, tab, loadHistory]);

  if (!isOpen) return null;

  const currentTemplate = templates.find((t) => t.id === selectedTemplateId);
  const total = activeBatch?.totalItems ?? 0;
  const completed = activeBatch?.completedItems ?? 0;
  const failed = activeBatch?.failedItems ?? 0;
  const cancelled = activeBatch?.cancelledItems ?? 0;
  const finished = completed + failed + cancelled;
  const percent =
    total > 0 ? Math.min(100, Math.round((finished / total) * 100)) : 0;
  const isBatchActive =
    activeBatch &&
    (activeBatch.status === "PENDING" ||
      activeBatch.status === "PROCESSING" ||
      activeBatch.status === "CANCELLING");

  return (
    <div
      className="batch-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${idPrefix}-modal-title`}
    >
      <div className="batch-modal-card">
        {/* Header */}
        <div className="batch-modal-header">
          <div>
            <h2 id={`${idPrefix}-modal-title`} className="batch-modal-title">
              Geração de Artes em Lote
            </h2>
            <p className="batch-modal-subtitle">
              {selectedPosts.length} publicação(ões) selecionada(s) para
              renderização sequencial e segura.
            </p>
          </div>
          <button
            type="button"
            className="batch-modal-close-btn"
            onClick={onClose}
            aria-label="Fechar modal de geração em lote"
          >
            ✕
          </button>
        </div>

        {/* Abas */}
        <div className="batch-modal-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "configure"}
            className={`batch-tab-btn ${tab === "configure" ? "active" : ""}`}
            onClick={() => setTab("configure")}
          >
            1. Configurar e Validar
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "progress"}
            className={`batch-tab-btn ${tab === "progress" ? "active" : ""}`}
            onClick={() => setTab("progress")}
            disabled={!activeBatch}
          >
            2. Progresso do Lote {activeBatch ? `(${percent}%)` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "history"}
            className={`batch-tab-btn ${tab === "history" ? "active" : ""}`}
            onClick={() => setTab("history")}
          >
            Histórico de Lotes
          </button>
        </div>

        {/* Alertas */}
        {error && (
          <div className="batch-alert batch-alert-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="batch-alert batch-alert-success" role="status">
            {notice}
          </div>
        )}

        {/* Conteúdo das Abas */}
        <div className="batch-modal-body">
          {tab === "configure" && (
            <div className="batch-config-panel">
              <div className="batch-form-group">
                <label
                  htmlFor={`${idPrefix}-template-select`}
                  className="batch-form-label"
                >
                  Modelo Declarativo de Design (Template)
                </label>
                {loadingTemplates ? (
                  <p className="batch-text-muted">
                    Carregando modelos ativos...
                  </p>
                ) : (
                  <select
                    id={`${idPrefix}-template-select`}
                    className="batch-select"
                    value={selectedTemplateId}
                    onChange={(e) => {
                      setSelectedTemplateId(e.target.value);
                      setValidationResult(null);
                    }}
                  >
                    {templates.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name}{" "}
                        {tpl.latestVersion
                          ? `(v${tpl.latestVersion.version} - ${tpl.latestVersion.format})`
                          : "(sem versão)"}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="batch-form-group">
                <label className="batch-form-label">
                  Formato de Renderização
                </label>
                <div className="batch-format-selector" role="radiogroup">
                  {(["PORTRAIT", "SQUARE", "STORY"] as DesignFormat[]).map(
                    (fmt) => {
                      const meta = FORMAT_METADATA[fmt];
                      const isSelected = selectedFormat === fmt;
                      return (
                        <button
                          key={fmt}
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          className={`batch-format-card ${isSelected ? "selected" : ""}`}
                          onClick={() => {
                            setSelectedFormat(fmt);
                            setValidationResult(null);
                          }}
                        >
                          <span className="batch-format-label">
                            {meta.label}
                          </span>
                          <span className="batch-format-dimensions">
                            {meta.dimensions}
                          </span>
                          <span className="batch-format-ratio">
                            Proporção {meta.ratio}
                          </span>
                        </button>
                      );
                    },
                  )}
                </div>
              </div>

              {/* Prévia de posts selecionados */}
              <div className="batch-posts-preview-box">
                <h3 className="batch-preview-title">
                  Publicações Selecionadas ({selectedPosts.length})
                </h3>
                <div className="batch-posts-list-scroll">
                  {selectedPosts.map((post) => (
                    <div key={post.id} className="batch-post-row">
                      <span className="batch-post-title">
                        {post.title || "Sem título"}
                      </span>
                      <span className="batch-post-caption-preview">
                        {post.caption.slice(0, 90)}...
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Resumo da Validação */}
              {validationResult && (
                <div
                  className={`batch-validation-card ${validationResult.valid ? "valid" : "warning"}`}
                >
                  <div className="batch-validation-header">
                    <strong>Resultado da Validação:</strong>
                    <span>
                      {validationResult.validItemsCount} de{" "}
                      {validationResult.totalRequested} itens aptos
                    </span>
                  </div>
                  <div className="batch-validation-details">
                    <p>
                      Estimativa de duração total: ~
                      {Math.ceil(validationResult.estimatedDurationMs / 1000)}s
                    </p>
                    <p className="batch-vps-note">
                      Alocação de recursos da VPS: Processamento sequencial em
                      fila (concorrência 1x) para prevenir picos de CPU e
                      memória.
                    </p>
                  </div>

                  {validationResult.invalidItems.length > 0 && (
                    <div className="batch-invalid-list">
                      <p className="batch-invalid-title">
                        Itens com restrições:
                      </p>
                      {validationResult.invalidItems.map(
                        (inv: { index: number; reasons: string[] }) => (
                          <div key={inv.index} className="batch-invalid-item">
                            <span>Item #{inv.index + 1}:</span>
                            <ul>
                              {inv.reasons.map((r: string, i: number) => (
                                <li key={i}>{r}</li>
                              ))}
                            </ul>
                          </div>
                        ),
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Botões de Ação */}
              <div className="batch-modal-footer">
                <button
                  type="button"
                  className="batch-btn batch-btn-secondary"
                  onClick={handleValidate}
                  disabled={
                    validating || submitting || selectedPosts.length === 0
                  }
                >
                  {validating ? "Validando..." : "Validar Lote"}
                </button>
                <button
                  type="button"
                  className="batch-btn batch-btn-primary"
                  onClick={handleStartBatch}
                  disabled={
                    submitting ||
                    validating ||
                    selectedPosts.length === 0 ||
                    !currentTemplate
                  }
                >
                  {submitting
                    ? "Iniciando Lote..."
                    : `Gerar ${selectedPosts.length} Arte(s) em Lote`}
                </button>
              </div>
            </div>
          )}

          {tab === "progress" && activeBatch && (
            <div className="batch-progress-panel">
              {/* Status e ID */}
              <div className="batch-status-header">
                <div>
                  <span className="batch-id-label">
                    Lote: #{activeBatch.id.slice(0, 8)}
                  </span>
                  <span
                    className={`batch-status-badge ${formatBatchStatusBadgeClass(activeBatch.status)}`}
                  >
                    {formatBatchStatusLabel(activeBatch.status)}
                  </span>
                </div>
                {isBatchActive ? (
                  <div>
                    {activeBatch.status === "CANCELLING" ? (
                      <span className="batch-cancelling-notice">
                        Cancelamento em andamento...
                      </span>
                    ) : !confirmingCancel ? (
                      <button
                        type="button"
                        className="batch-btn batch-btn-danger"
                        onClick={() => setConfirmingCancel(true)}
                        disabled={cancelling}
                      >
                        Cancelar Lote Restante
                      </button>
                    ) : (
                      <div className="batch-cancel-confirm-box">
                        <span>Confirmar cancelamento?</span>
                        <button
                          type="button"
                          className="batch-btn batch-btn-danger-confirm"
                          onClick={handleCancelBatch}
                          disabled={cancelling}
                        >
                          {cancelling ? "Cancelando..." : "Sim, Cancelar"}
                        </button>
                        <button
                          type="button"
                          className="batch-btn batch-btn-ghost"
                          onClick={() => setConfirmingCancel(false)}
                          disabled={cancelling}
                        >
                          Voltar
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  activeBatch.failedItems > 0 && (
                    <button
                      type="button"
                      className="batch-btn batch-btn-secondary"
                      onClick={handleRetryFailedBatch}
                      disabled={submitting}
                    >
                      {submitting ? "Repetindo..." : "Repetir Itens Falhos"}
                    </button>
                  )
                )}
              </div>

              {/* Barra de Progresso */}
              <div className="batch-progress-bar-container">
                <div
                  className="batch-progress-bar-fill"
                  style={{ width: `${percent}%` }}
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>
              <div className="batch-progress-percent-label">
                <span>{percent}% concluído</span>
                <span>
                  {finished} de {total} processados
                </span>
              </div>

              {/* Grid de Contadores Atômicos */}
              <div className="batch-counters-grid">
                <div className="batch-counter-card">
                  <span className="batch-counter-value">
                    {activeBatch.totalItems}
                  </span>
                  <span className="batch-counter-title">Total</span>
                </div>
                <div className="batch-counter-card batch-counter-completed">
                  <span className="batch-counter-value">
                    {activeBatch.completedItems}
                  </span>
                  <span className="batch-counter-title">Concluídos</span>
                </div>
                <div className="batch-counter-card batch-counter-processing">
                  <span className="batch-counter-value">
                    {activeBatch.processingItems}
                  </span>
                  <span className="batch-counter-title">Processando</span>
                </div>
                <div className="batch-counter-card batch-counter-pending">
                  <span className="batch-counter-value">
                    {activeBatch.pendingItems}
                  </span>
                  <span className="batch-counter-title">Pendentes</span>
                </div>
                <div className="batch-counter-card batch-counter-failed">
                  <span className="batch-counter-value">
                    {activeBatch.failedItems}
                  </span>
                  <span className="batch-counter-title">Falhos</span>
                </div>
                <div className="batch-counter-card batch-counter-cancelled">
                  <span className="batch-counter-value">
                    {activeBatch.cancelledItems}
                  </span>
                  <span className="batch-counter-title">Cancelados</span>
                </div>
              </div>

              {/* Itens do Lote */}
              <div className="batch-items-container">
                <h3 className="batch-items-heading">
                  Itens do Lote ({batchItems.length})
                </h3>
                {loadingItems && batchItems.length === 0 ? (
                  <p className="batch-text-muted">Carregando itens...</p>
                ) : (
                  <div className="batch-items-table-wrapper">
                    <table className="batch-items-table">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th>Status</th>
                          <th>Tentativa</th>
                          <th>Arte Gerada</th>
                        </tr>
                      </thead>
                      <tbody>
                        {batchItems.map((item, idx) => (
                          <tr key={item.id}>
                            <td>
                              <div className="batch-item-cell">
                                <span className="batch-item-index">
                                  #{idx + 1}
                                </span>
                                <span className="batch-item-id">
                                  {item.postId
                                    ? `Post #${item.postId.slice(0, 8)}`
                                    : item.id.slice(0, 8)}
                                </span>
                              </div>
                            </td>
                            <td>
                              <span
                                className={`batch-item-status-tag ${item.status.toLowerCase()}`}
                              >
                                {item.status}
                              </span>
                            </td>
                            <td>{item.attemptNumber}x</td>
                            <td>
                              {item.outputMediaUrl ? (
                                <a
                                  href={item.outputMediaUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="batch-item-media-link"
                                >
                                  Ver Arte ↗
                                </a>
                              ) : item.status === "FAILED" ? (
                                <span className="batch-item-error-code">
                                  {item.errorCode ?? "Falhou"}
                                </span>
                              ) : (
                                <span className="batch-text-muted">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "history" && (
            <div className="batch-history-panel">
              <h3 className="batch-history-title">
                Histórico de Lotes do Cliente
              </h3>
              {loadingHistory ? (
                <p className="batch-text-muted">
                  Carregando lotes anteriores...
                </p>
              ) : historyBatches.length === 0 ? (
                <p className="batch-text-muted">
                  Nenhum lote gerado até o momento.
                </p>
              ) : (
                <div className="batch-history-list">
                  {historyBatches.map((h) => (
                    <div
                      key={h.id}
                      className="batch-history-card"
                      onClick={() => startTrackingBatch(h)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="batch-history-info">
                        <span className="batch-history-id">
                          Lote #{h.id.slice(0, 8)}
                        </span>
                        <span className="batch-history-format">{h.format}</span>
                        <span className="batch-history-date">
                          {new Date(h.createdAt).toLocaleString("pt-BR")}
                        </span>
                      </div>
                      <div className="batch-history-status">
                        <span
                          className={`batch-status-badge ${formatBatchStatusBadgeClass(h.status)}`}
                        >
                          {formatBatchStatusLabel(h.status)}
                        </span>
                        <span className="batch-history-counters">
                          {h.completedItems}/{h.totalItems} concluídos
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
