"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { DesignFormat, DesignTemplateSpec } from "@socialflow/contracts";

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

interface DesignTemplateVersionDetail {
  id: string;
  version: number;
  format: DesignFormat;
  spec: DesignTemplateSpec;
  specHash: string;
  rendererVersion: string;
  createdAt: string;
}

interface DesignTemplateDetail {
  id: string;
  name: string;
  systemKey: string | null;
  status: "ACTIVE" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
  versions: DesignTemplateVersionDetail[];
}

interface MediaAssetSummary {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  byteSize: number;
}

interface RenderJobItem {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  templateVersionId: string;
  postId: string | null;
  backgroundMediaAssetId: string | null;
  logoMediaAssetId: string | null;
  outputMediaAssetId: string | null;
  outputMediaUrl: string | null;
  attemptNumber: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface ArtworkGeneratorProps {
  org: string;
  clientId: string;
  canGenerate: boolean;
  canInitializeTemplates: boolean;
  onArtworkCompleted?: () => void;
}

const FORMAT_METADATA: Record<
  DesignFormat,
  { label: string; dimensions: string; ratio: string }
> = {
  SQUARE: {
    label: "Quadrado",
    dimensions: "1080 × 1080",
    ratio: "1 / 1",
  },
  PORTRAIT: {
    label: "Retrato",
    dimensions: "1080 × 1350",
    ratio: "4 / 5",
  },
  STORY: {
    label: "Story",
    dimensions: "1080 × 1920",
    ratio: "9 / 16",
  },
};

function formatStatusLabel(status: RenderJobItem["status"]): string {
  switch (status) {
    case "PENDING":
      return "Pendente";
    case "PROCESSING":
      return "Em processamento";
    case "COMPLETED":
      return "Concluído";
    case "FAILED":
      return "Falhou";
    default:
      return status;
  }
}

function formatStatusClass(status: RenderJobItem["status"]): string {
  switch (status) {
    case "COMPLETED":
      return "badge-published";
    case "PROCESSING":
      return "badge-processing";
    case "PENDING":
      return "badge-scheduled";
    case "FAILED":
      return "badge-failed";
    default:
      return "badge-cancelled";
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

async function requestApi<T>(
  url: string,
  options?: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    signal,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      data.message ??
        "Não foi possível concluir a solicitação. Tente novamente.",
    );
  }
  return data as T;
}

export function ArtworkGenerator({
  org,
  clientId,
  canGenerate,
  canInitializeTemplates,
  onArtworkCompleted,
}: ArtworkGeneratorProps) {
  const idPrefix = useId();

  // Rotas base
  const templatesBase = `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}/design-templates`;
  const renderJobsBase = `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}/render-jobs`;
  const mediaBase = `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}/media`;

  // Estados dos Modelos
  const [templates, setTemplates] = useState<DesignTemplateListItem[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templatesHasMore, setTemplatesHasMore] = useState(false);
  const [templatesCursor, setTemplatesCursor] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null,
  );
  const [selectedDetail, setSelectedDetail] =
    useState<DesignTemplateDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [initializingDefaults, setInitializingDefaults] = useState(false);

  // Estados do Formulário da Arte
  const [eyebrow, setEyebrow] = useState("");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [callToAction, setCallToAction] = useState("");
  const [backgroundMediaAssetId, setBackgroundMediaAssetId] = useState<
    string | null
  >(null);
  const [logoMediaAssetId, setLogoMediaAssetId] = useState<string | null>(null);

  // Idempotência estável
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() =>
    crypto.randomUUID(),
  );
  const [submitting, setSubmitting] = useState(false);

  // Job Ativo e Polling
  const [activeJob, setActiveJob] = useState<RenderJobItem | null>(null);
  const [pollingTimeoutReached, setPollingTimeoutReached] = useState(false);
  const [refreshingJob, setRefreshingJob] = useState(false);

  // Biblioteca de Mídias para Seleção
  const [mediaAssets, setMediaAssets] = useState<MediaAssetSummary[]>([]);
  const [mediaHasMore, setMediaHasMore] = useState(false);
  const [mediaPage, setMediaPage] = useState(1);
  const [loadingMedia, setLoadingMedia] = useState(false);

  // Histórico de Renderizações Recentes
  const [history, setHistory] = useState<RenderJobItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);

  // Mensagens e Alertas
  const [generalError, setGeneralError] = useState("");
  const [generalNotice, setGeneralNotice] = useState("");

  // Refs de controle de ciclo de vida e polling
  const isMountedRef = useRef(true);
  const pollingAbortControllerRef = useRef<AbortController | null>(null);
  const pollingCountRef = useRef(0);

  // Limpa estados ao desmontar ou trocar de cliente/organização
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (pollingAbortControllerRef.current) {
        pollingAbortControllerRef.current.abort();
      }
    };
  }, []);

  // Quando trocar de cliente ou organização: reseta o formulário e gera nova intenção
  useEffect(() => {
    setSelectedTemplateId(null);
    setSelectedDetail(null);
    setEyebrow("");
    setTitle("");
    setSubtitle("");
    setCallToAction("");
    setBackgroundMediaAssetId(null);
    setLogoMediaAssetId(null);
    setActiveJob(null);
    setPollingTimeoutReached(false);
    setIdempotencyKey(crypto.randomUUID());
    setGeneralError("");
    setGeneralNotice("");
    setTemplatesCursor(null);
    setHistoryCursor(null);
    setMediaPage(1);
  }, [org, clientId]);

  // Carrega templates ativos
  const loadTemplates = useCallback(
    async (cursor?: string) => {
      try {
        setLoadingTemplates(true);
        const url = `${templatesBase}?status=ACTIVE&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const data = await requestApi<{
          items: DesignTemplateListItem[];
          nextCursor: string | null;
          hasMore: boolean;
        }>(url);

        if (!isMountedRef.current) return;

        setTemplates((prev) =>
          cursor ? [...prev, ...data.items] : data.items,
        );
        setTemplatesHasMore(data.hasMore);
        setTemplatesCursor(data.nextCursor);

        // Se nenhum template selecionado, seleciona o primeiro disponível
        if (!cursor && data.items.length > 0) {
          setSelectedTemplateId((prev) => prev ?? data.items[0]?.id ?? null);
        }
      } catch (err: unknown) {
        if (isMountedRef.current) {
          setGeneralError((err as Error).message);
        }
      } finally {
        if (isMountedRef.current) {
          setLoadingTemplates(false);
        }
      }
    },
    [templatesBase],
  );

  // Carrega histórico de renderizações
  const loadHistory = useCallback(
    async (cursor?: string) => {
      try {
        setLoadingHistory(true);
        const url = `${renderJobsBase}?limit=15${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const data = await requestApi<{
          items: RenderJobItem[];
          nextCursor: string | null;
          hasMore: boolean;
        }>(url);

        if (!isMountedRef.current) return;

        setHistory((prev) => (cursor ? [...prev, ...data.items] : data.items));
        setHistoryHasMore(data.hasMore);
        setHistoryCursor(data.nextCursor);
      } catch (err: unknown) {
        if (isMountedRef.current) {
          setGeneralError((err as Error).message);
        }
      } finally {
        if (isMountedRef.current) {
          setLoadingHistory(false);
        }
      }
    },
    [renderJobsBase],
  );

  // Carrega mídias elegíveis para seleção
  const loadMedia = useCallback(
    async (pageToLoad = 1) => {
      try {
        setLoadingMedia(true);
        const url = `${mediaBase}?page=${pageToLoad}`;
        const data = await requestApi<{
          items: MediaAssetSummary[];
          hasMore: boolean;
          available: boolean;
        }>(url);

        if (!isMountedRef.current) return;

        setMediaAssets((prev) =>
          pageToLoad === 1 ? data.items : [...prev, ...data.items],
        );
        setMediaHasMore(data.hasMore);
        setMediaPage(pageToLoad);
      } catch {
        // Se a biblioteca estiver vazia ou indisponível, continua sem interromper o gerador
      } finally {
        if (isMountedRef.current) {
          setLoadingMedia(false);
        }
      }
    },
    [mediaBase],
  );

  // Carrega templates, histórico e mídias na inicialização do componente
  useEffect(() => {
    void loadTemplates();
    void loadHistory();
    void loadMedia(1);
  }, [loadTemplates, loadHistory, loadMedia]);

  // Carrega detalhes do template selecionado
  useEffect(() => {
    if (!selectedTemplateId) {
      setSelectedDetail(null);
      return;
    }

    let active = true;
    setLoadingDetail(true);

    requestApi<DesignTemplateDetail>(`${templatesBase}/${selectedTemplateId}`)
      .then((detail) => {
        if (active) {
          setSelectedDetail(detail);
        }
      })
      .catch((err) => {
        if (active) {
          setGeneralError((err as Error).message);
        }
      })
      .finally(() => {
        if (active) {
          setLoadingDetail(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedTemplateId, templatesBase]);

  // Encontra a versão com maior número de versão
  const latestVersion = selectedDetail?.versions?.length
    ? [...selectedDetail.versions].sort((a, b) => b.version - a.version)[0]
    : null;

  const currentSpec: DesignTemplateSpec | null = latestVersion?.spec ?? null;
  const currentFormat: DesignFormat = latestVersion?.format ?? "SQUARE";

  // Se qualquer campo do formulário mudar após uma tentativa, gera uma nova chave de idempotência
  const handleInputChange = useCallback(
    <T,>(setter: (val: T) => void, val: T) => {
      setter(val);
      // Gera nova chave se o formulário for alterado
      setIdempotencyKey(crypto.randomUUID());
      setGeneralError("");
    },
    [],
  );

  // Inicializa modelos padrão (OWNER ou ADMIN)
  async function handleInitializeDefaults() {
    try {
      setInitializingDefaults(true);
      setGeneralError("");
      setGeneralNotice("");

      await requestApi<{
        created: boolean;
        templates: DesignTemplateListItem[];
      }>(`${templatesBase}/default`, {
        method: "POST",
      });

      setGeneralNotice("Modelos padrão inicializados com sucesso!");
      await loadTemplates();
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    } finally {
      setInitializingDefaults(false);
    }
  }

  // Polling resiliente do job ativo
  const pollJobStatus = useCallback(
    async (jobId: string) => {
      if (pollingAbortControllerRef.current) {
        pollingAbortControllerRef.current.abort();
      }
      const controller = new AbortController();
      pollingAbortControllerRef.current = controller;

      try {
        const updated = await requestApi<RenderJobItem>(
          `${renderJobsBase}/${jobId}`,
          undefined,
          controller.signal,
        );

        if (!isMountedRef.current) return;

        setActiveJob(updated);

        // Atualiza item correspondente no histórico
        setHistory((prev) =>
          prev.map((item) => (item.id === updated.id ? updated : item)),
        );

        if (updated.status === "COMPLETED") {
          setPollingTimeoutReached(false);
          setGeneralNotice(
            "Arte gerada com sucesso! A imagem também foi adicionada à sua Biblioteca de Imagens.",
          );
          if (onArtworkCompleted) {
            onArtworkCompleted();
          }
          void loadHistory();
          return;
        }

        if (updated.status === "FAILED") {
          setPollingTimeoutReached(false);
          return;
        }

        // Se ainda PENDING ou PROCESSING
        pollingCountRef.current += 1;

        // Limite de polling (~25 tentativas x 1.6s ≈ 40s)
        if (pollingCountRef.current >= 25) {
          setPollingTimeoutReached(true);
          return;
        }

        // Aguarda intervalo respeitando visibilidade da aba
        const delay = document.visibilityState === "hidden" ? 4000 : 1600;
        setTimeout(() => {
          if (
            isMountedRef.current &&
            (updated.status === "PENDING" || updated.status === "PROCESSING")
          ) {
            void pollJobStatus(jobId);
          }
        }, delay);
      } catch (err: unknown) {
        if ((err as Error)?.name === "AbortError") return;
        // Falha transitória de consulta: continua tentando até o teto
        pollingCountRef.current += 1;
        if (pollingCountRef.current < 25) {
          setTimeout(() => {
            if (isMountedRef.current) {
              void pollJobStatus(jobId);
            }
          }, 2000);
        } else {
          setPollingTimeoutReached(true);
        }
      }
    },
    [renderJobsBase, onArtworkCompleted, loadHistory],
  );

  // Consulta manual caso o polling atinja o limite
  async function handleManualStatusCheck() {
    if (!activeJob) return;
    try {
      setRefreshingJob(true);
      const updated = await requestApi<RenderJobItem>(
        `${renderJobsBase}/${activeJob.id}`,
      );
      setActiveJob(updated);
      setHistory((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item)),
      );
      if (updated.status === "COMPLETED") {
        setPollingTimeoutReached(false);
        setGeneralNotice("Arte concluída!");
        if (onArtworkCompleted) {
          onArtworkCompleted();
        }
        void loadHistory();
      } else if (updated.status === "FAILED") {
        setPollingTimeoutReached(false);
      }
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    } finally {
      setRefreshingJob(false);
    }
  }

  // Submissão do formulário para geração da arte
  async function handleSubmitArtwork(e: React.FormEvent) {
    e.preventDefault();

    if (!canGenerate) {
      setGeneralError("Seu perfil não possui permissão para gerar artes.");
      return;
    }

    if (!latestVersion) {
      setGeneralError(
        "O modelo selecionado não possui versão válida para geração.",
      );
      return;
    }

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setGeneralError("O título da arte é obrigatório.");
      return;
    }

    if (trimmedTitle.length > 180) {
      setGeneralError("O título deve ter no máximo 180 caracteres.");
      return;
    }

    // Previne envio duplicado por duplo clique
    if (submitting) return;

    setSubmitting(true);
    setGeneralError("");
    setGeneralNotice("");
    setPollingTimeoutReached(false);
    pollingCountRef.current = 0;

    // Monta o payload estrito com base nas flags do template
    const inputPayload = {
      eyebrow: currentSpec?.showEyebrow ? eyebrow.trim() : "",
      title: trimmedTitle,
      subtitle: currentSpec?.showSubtitle ? subtitle.trim() : "",
      callToAction: currentSpec?.showCallToAction ? callToAction.trim() : "",
      backgroundMediaAssetId: backgroundMediaAssetId || null,
      logoMediaAssetId: logoMediaAssetId || null,
    };

    const payload = {
      templateVersionId: latestVersion.id,
      postId: null,
      input: inputPayload,
      idempotencyKey,
    };

    try {
      const job = await requestApi<RenderJobItem>(renderJobsBase, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setActiveJob(job);
      // Adiciona ao topo do histórico se não existir
      setHistory((prev) => {
        const exists = prev.some((item) => item.id === job.id);
        return exists
          ? prev.map((item) => (item.id === job.id ? job : item))
          : [job, ...prev];
      });

      // Inicia polling caso não tenha vindo concluído de imediato
      if (job.status === "PENDING" || job.status === "PROCESSING") {
        void pollJobStatus(job.id);
      } else if (job.status === "COMPLETED") {
        setGeneralNotice("Arte gerada com sucesso!");
        if (onArtworkCompleted) {
          onArtworkCompleted();
        }
      }
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  // Iniciar nova arte (limpa o formulário e gera nova intenção idempotente)
  function handleStartNewArtwork() {
    setTitle("");
    setEyebrow("");
    setSubtitle("");
    setCallToAction("");
    setBackgroundMediaAssetId(null);
    setLogoMediaAssetId(null);
    setActiveJob(null);
    setPollingTimeoutReached(false);
    setIdempotencyKey(crypto.randomUUID());
    setGeneralNotice("");
    setGeneralError("");
  }

  // Resolve URLs autenticadas das mídias para prévia
  const bgMediaUrl = backgroundMediaAssetId
    ? `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}/media/${encodeURIComponent(backgroundMediaAssetId)}/content`
    : null;
  const logoMediaUrl = logoMediaAssetId
    ? `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}/media/${encodeURIComponent(logoMediaAssetId)}/content`
    : null;

  return (
    <section
      aria-label="Gerador de artes"
      className="artwork-generator-section"
      role="region"
    >
      <div className="section-header">
        <div>
          <h2>Gerador de artes</h2>
          <p className="muted">
            Crie peças visuais profissionais padronizadas nos formatos quadrado,
            retrato e story.
          </p>
        </div>
      </div>

      {generalError && (
        <p role="alert" className="error">
          {generalError}
        </p>
      )}

      {generalNotice && (
        <p role="status" className="notice">
          {generalNotice}
        </p>
      )}

      {/* 1. Catálogo e Inicialização de Modelos */}
      {loadingTemplates ? (
        <p role="status" className="empty">
          Carregando modelos de design…
        </p>
      ) : templates.length === 0 ? (
        <div className="empty-templates-card">
          <h3>Nenhum modelo de design disponível</h3>
          <p>
            O Gerador de Artes utiliza modelos predefinidos nos três formatos
            principais das redes sociais:
          </p>
          <div className="format-explainer-grid">
            <div className="format-explainer-item">
              <strong>Quadrado (1080 × 1080)</strong>
              <p>Ideal para feed clássico no Instagram, LinkedIn e Facebook.</p>
            </div>
            <div className="format-explainer-item">
              <strong>Retrato (1080 × 1350)</strong>
              <p>Ocupa 25% a mais de tela no feed móvel para maior impacto.</p>
            </div>
            <div className="format-explainer-item">
              <strong>Story (1080 × 1920)</strong>
              <p>Proporção vertical completa para Stories e Reels.</p>
            </div>
          </div>

          {canInitializeTemplates ? (
            <button
              type="button"
              onClick={handleInitializeDefaults}
              disabled={initializingDefaults}
            >
              {initializingDefaults
                ? "Inicializando modelos…"
                : "Criar modelos iniciais"}
            </button>
          ) : canGenerate ? (
            <p className="muted">
              Solicite a um proprietário ou administrador da organização que
              inicialize os modelos padrão.
            </p>
          ) : (
            <p className="muted">
              Nenhum modelo cadastrado. Consulte um administrador para habilitar
              modelos neste cliente.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="template-catalog-header">
            <h3>Escolha o modelo da arte</h3>
            <span className="muted">
              {templates.length} modelo(s) disponível(is)
            </span>
          </div>

          <div
            className="template-cards-grid"
            role="radiogroup"
            aria-label="Modelos de design disponíveis"
          >
            {templates.map((tpl) => {
              const format = tpl.latestVersion?.format ?? "SQUARE";
              const meta = FORMAT_METADATA[format];
              const isSelected = selectedTemplateId === tpl.id;

              return (
                <div
                  key={tpl.id}
                  role="radio"
                  aria-checked={isSelected}
                  tabIndex={0}
                  className={`template-select-card ${isSelected ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedTemplateId(tpl.id);
                    // Gera nova intenção idempotente ao mudar o modelo
                    setIdempotencyKey(crypto.randomUUID());
                  }}
                  onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      setSelectedTemplateId(tpl.id);
                      setIdempotencyKey(crypto.randomUUID());
                    }
                  }}
                >
                  <div className="template-card-top">
                    <span
                      className={`format-tag format-${format.toLowerCase()}`}
                    >
                      {meta.label}
                    </span>
                    <span className="version-tag">
                      v{tpl.latestVersion?.version ?? 1}
                    </span>
                  </div>
                  <h4 className="template-name">{tpl.name}</h4>
                  <p className="template-dimensions muted">{meta.dimensions}</p>
                  <div
                    className={`format-indicator-box ratio-${format.toLowerCase()}`}
                    aria-hidden="true"
                  />
                </div>
              );
            })}
          </div>

          {templatesHasMore && templatesCursor && (
            <div className="load-more-row">
              <button
                type="button"
                className="quiet"
                onClick={() => void loadTemplates(templatesCursor)}
                disabled={loadingTemplates}
              >
                Carregar mais modelos
              </button>
            </div>
          )}

          {/* 2. Workspace do Formulário + Prévia */}
          {selectedTemplateId && (
            <div className="artwork-workspace-grid">
              {/* Coluna da Esquerda: Formulário e Seletores */}
              <div className="artwork-form-column">
                {!canGenerate ? (
                  <div className="readonly-notice-card">
                    <h4>Modo somente leitura</h4>
                    <p className="muted">
                      Seu perfil pode visualizar o catálogo de modelos e o
                      histórico de artes geradas, mas não pode preencher novos
                      conteúdos ou solicitar renderizações.
                    </p>
                  </div>
                ) : loadingDetail ? (
                  <p role="status" className="empty">
                    Carregando detalhes do modelo…
                  </p>
                ) : !latestVersion ? (
                  <p role="alert" className="error">
                    Este modelo não possui uma versão válida para renderização.
                    Escolha outro modelo.
                  </p>
                ) : (
                  <form
                    onSubmit={handleSubmitArtwork}
                    className="artwork-compose-form"
                  >
                    <div className="form-legend">
                      <h3>Conteúdo da arte</h3>
                      <p className="muted">
                        Preencha os textos e escolha as imagens complementares
                        da sua biblioteca.
                      </p>
                    </div>

                    {/* Chamada Superior (Eyebrow) */}
                    {currentSpec?.showEyebrow && (
                      <div className="field-group">
                        <div className="label-row">
                          <label htmlFor={`${idPrefix}-eyebrow`}>
                            Chamada superior
                          </label>
                          <span className="char-count">
                            {eyebrow.length} / 60
                          </span>
                        </div>
                        <input
                          id={`${idPrefix}-eyebrow`}
                          type="text"
                          maxLength={60}
                          value={eyebrow}
                          onChange={(e) =>
                            handleInputChange(setEyebrow, e.target.value)
                          }
                          placeholder="Ex.: NOVIDADE, DICA DA SEMANA…"
                        />
                        <small className="help">
                          Opcional. Até 60 caracteres.
                        </small>
                      </div>
                    )}

                    {/* Título (Title) */}
                    <div className="field-group">
                      <div className="label-row">
                        <label htmlFor={`${idPrefix}-title`}>Título *</label>
                        <span className="char-count">{title.length} / 180</span>
                      </div>
                      <textarea
                        id={`${idPrefix}-title`}
                        required
                        minLength={1}
                        maxLength={180}
                        rows={3}
                        value={title}
                        onChange={(e) =>
                          handleInputChange(setTitle, e.target.value)
                        }
                        placeholder="Insira o título principal da arte…"
                      />
                      <small className="help">
                        Obrigatório. De 1 a 180 caracteres. Limite visual de{" "}
                        {currentSpec?.titleMaxLines ?? 3} linhas no modelo.
                      </small>
                    </div>

                    {/* Texto Complementar (Subtitle) */}
                    {currentSpec?.showSubtitle && (
                      <div className="field-group">
                        <div className="label-row">
                          <label htmlFor={`${idPrefix}-subtitle`}>
                            Texto complementar
                          </label>
                          <span className="char-count">
                            {subtitle.length} / 300
                          </span>
                        </div>
                        <textarea
                          id={`${idPrefix}-subtitle`}
                          maxLength={300}
                          rows={2}
                          value={subtitle}
                          onChange={(e) =>
                            handleInputChange(setSubtitle, e.target.value)
                          }
                          placeholder="Texto de apoio ou contexto adicional…"
                        />
                        <small className="help">
                          Opcional. Até 300 caracteres.
                        </small>
                      </div>
                    )}

                    {/* Chamada para Ação (Call to Action) */}
                    {currentSpec?.showCallToAction && (
                      <div className="field-group">
                        <div className="label-row">
                          <label htmlFor={`${idPrefix}-cta`}>
                            Chamada para ação
                          </label>
                          <span className="char-count">
                            {callToAction.length} / 40
                          </span>
                        </div>
                        <input
                          id={`${idPrefix}-cta`}
                          type="text"
                          maxLength={40}
                          value={callToAction}
                          onChange={(e) =>
                            handleInputChange(setCallToAction, e.target.value)
                          }
                          placeholder="Ex.: SAIBA MAIS, VISITE O SITE…"
                        />
                        <small className="help">
                          Opcional. Até 40 caracteres.
                        </small>
                      </div>
                    )}

                    {/* Seletor de Imagem de Fundo */}
                    <div className="field-group">
                      <label id={`${idPrefix}-bg-label`}>Imagem de fundo</label>
                      <small className="help">
                        Selecione uma imagem da sua biblioteca ou use apenas as
                        cores do modelo.
                      </small>
                      <div
                        className="media-selector-box"
                        role="group"
                        aria-labelledby={`${idPrefix}-bg-label`}
                      >
                        <button
                          type="button"
                          className={`media-option-card ${backgroundMediaAssetId === null ? "active" : ""}`}
                          onClick={() =>
                            handleInputChange(setBackgroundMediaAssetId, null)
                          }
                        >
                          <span className="no-media-icon" aria-hidden="true">
                            ∅
                          </span>
                          <span className="media-name">
                            Nenhuma (Cor sólida)
                          </span>
                        </button>

                        {mediaAssets.map((asset) => {
                          const isSelected =
                            backgroundMediaAssetId === asset.id;
                          return (
                            <button
                              key={`bg-${asset.id}`}
                              type="button"
                              className={`media-option-card ${isSelected ? "active" : ""}`}
                              onClick={() =>
                                handleInputChange(
                                  setBackgroundMediaAssetId,
                                  asset.id,
                                )
                              }
                            >
                              <img
                                src={`${mediaBase}/${encodeURIComponent(asset.id)}/content`}
                                alt={asset.name}
                                className="media-thumbnail"
                              />
                              <span className="media-name">{asset.name}</span>
                              <span className="media-dim muted">
                                {asset.width} × {asset.height}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {mediaHasMore && (
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => void loadMedia(mediaPage + 1)}
                          disabled={loadingMedia}
                        >
                          Carregar mais imagens
                        </button>
                      )}
                    </div>

                    {/* Seletor de Logotipo */}
                    <div className="field-group">
                      <label id={`${idPrefix}-logo-label`}>Logotipo</label>
                      <small className="help">
                        Insira a marca ou logotipo do cliente na arte.
                      </small>
                      <div
                        className="media-selector-box"
                        role="group"
                        aria-labelledby={`${idPrefix}-logo-label`}
                      >
                        <button
                          type="button"
                          className={`media-option-card ${logoMediaAssetId === null ? "active" : ""}`}
                          onClick={() =>
                            handleInputChange(setLogoMediaAssetId, null)
                          }
                        >
                          <span className="no-media-icon" aria-hidden="true">
                            ∅
                          </span>
                          <span className="media-name">Nenhum</span>
                        </button>

                        {mediaAssets.map((asset) => {
                          const isSelected = logoMediaAssetId === asset.id;
                          return (
                            <button
                              key={`logo-${asset.id}`}
                              type="button"
                              className={`media-option-card ${isSelected ? "active" : ""}`}
                              onClick={() =>
                                handleInputChange(setLogoMediaAssetId, asset.id)
                              }
                            >
                              <img
                                src={`${mediaBase}/${encodeURIComponent(asset.id)}/content`}
                                alt={asset.name}
                                className="media-thumbnail"
                              />
                              <span className="media-name">{asset.name}</span>
                              <span className="media-dim muted">
                                {asset.width} × {asset.height}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Resumo e Ação de Envio */}
                    <div className="submission-box">
                      <div className="summary-details">
                        <strong>Resumo da geração:</strong>
                        <span>Modelo: {selectedDetail?.name}</span>
                        <span>
                          Formato: {FORMAT_METADATA[currentFormat]?.label} (
                          {FORMAT_METADATA[currentFormat]?.dimensions})
                        </span>
                        <span>
                          Fundo:{" "}
                          {backgroundMediaAssetId
                            ? "Personalizado"
                            : "Cor do modelo"}
                        </span>
                        <span>
                          Logotipo:{" "}
                          {logoMediaAssetId ? "Selecionado" : "Nenhum"}
                        </span>
                      </div>

                      <div className="form-actions">
                        <button
                          type="submit"
                          disabled={submitting || !title.trim()}
                        >
                          {submitting ? "Enviando solicitação…" : "Gerar arte"}
                        </button>

                        {(activeJob || title) && (
                          <button
                            type="button"
                            className="quiet"
                            onClick={handleStartNewArtwork}
                            disabled={submitting}
                          >
                            Nova arte
                          </button>
                        )}
                      </div>
                    </div>
                  </form>
                )}
              </div>

              {/* Coluna da Direita: Prévia Segura e Status de Renderização */}
              <div className="artwork-preview-column">
                <div className="preview-heading">
                  <h3>Prévia do modelo</h3>
                  <span className="muted">
                    {FORMAT_METADATA[currentFormat]?.label} (
                    {FORMAT_METADATA[currentFormat]?.dimensions})
                  </span>
                </div>

                {/* Container com proporção correta */}
                <div
                  className="preview-viewport-wrapper"
                  style={{
                    aspectRatio: FORMAT_METADATA[currentFormat]?.ratio,
                  }}
                >
                  <div
                    className="preview-artboard"
                    style={{
                      backgroundColor:
                        currentSpec?.backgroundColor ?? "#0F172A",
                      padding: `${Math.round(((currentSpec?.safeArea ?? 80) / 1080) * 100)}%`,
                    }}
                  >
                    {/* Imagem de Fundo (se selecionada) */}
                    {bgMediaUrl && (
                      <img
                        src={bgMediaUrl}
                        alt=""
                        className="preview-bg-layer"
                        style={{ objectFit: "cover" }}
                      />
                    )}

                    {/* Sobreposição de Cor e Opacidade */}
                    <div
                      className="preview-overlay-layer"
                      style={{
                        backgroundColor: currentSpec?.overlayColor ?? "#000000",
                        opacity: currentSpec?.overlayOpacity ?? 0.3,
                      }}
                    />

                    {/* Conteúdo textual seguro (Renderizado como texto puro React) */}
                    <div
                      className="preview-content-layer"
                      style={{
                        textAlign: currentSpec?.textAlign ?? "left",
                      }}
                    >
                      {currentSpec?.showEyebrow && eyebrow && (
                        <div
                          className="preview-eyebrow"
                          style={{
                            color: currentSpec?.accentColor ?? "#E9C46A",
                          }}
                        >
                          {eyebrow}
                        </div>
                      )}

                      <h3
                        className="preview-title"
                        style={{
                          color: currentSpec?.textColor ?? "#FFFFFF",
                          WebkitLineClamp: currentSpec?.titleMaxLines ?? 3,
                        }}
                      >
                        {title.trim() || "Título da sua arte"}
                      </h3>

                      {currentSpec?.showSubtitle && subtitle && (
                        <p
                          className="preview-subtitle"
                          style={{
                            color: currentSpec?.mutedTextColor ?? "#94A3B8",
                          }}
                        >
                          {subtitle}
                        </p>
                      )}

                      {currentSpec?.showCallToAction && callToAction && (
                        <div
                          className="preview-cta-badge"
                          style={{
                            backgroundColor:
                              currentSpec?.accentColor ?? "#E9C46A",
                            color: currentSpec?.backgroundColor ?? "#0F172A",
                          }}
                        >
                          {callToAction}
                        </div>
                      )}

                      {logoMediaUrl && (
                        <div className="preview-logo-container">
                          <img
                            src={logoMediaUrl}
                            alt=""
                            className="preview-logo-image"
                            style={{ objectFit: "contain" }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Status da Renderização Ativa */}
                {activeJob && (
                  <div
                    className={`render-job-status-card status-${activeJob.status.toLowerCase()}`}
                    role={activeJob.status === "FAILED" ? "alert" : "status"}
                    aria-live="polite"
                  >
                    <div className="job-status-header">
                      <span
                        className={`status-badge ${formatStatusClass(activeJob.status)}`}
                      >
                        {formatStatusLabel(activeJob.status)}
                      </span>
                      <small className="muted">
                        Solicitado em {formatDate(activeJob.createdAt)}
                      </small>
                    </div>

                    {activeJob.status === "PENDING" && (
                      <p className="job-status-msg">
                        Aguardando na fila de renderização…
                      </p>
                    )}

                    {activeJob.status === "PROCESSING" && (
                      <p className="job-status-msg">
                        Renderizando pixels da arte com Satori e Sharp…
                        (Tentativa {activeJob.attemptNumber})
                      </p>
                    )}

                    {pollingTimeoutReached &&
                      (activeJob.status === "PENDING" ||
                        activeJob.status === "PROCESSING") && (
                        <div className="job-polling-timeout-notice">
                          <p className="muted">
                            O processamento está levando mais tempo que o
                            habitual, mas continua em segundo plano.
                          </p>
                          <button
                            type="button"
                            className="quiet"
                            onClick={() => void handleManualStatusCheck()}
                            disabled={refreshingJob}
                          >
                            {refreshingJob
                              ? "Verificando…"
                              : "Atualizar status"}
                          </button>
                        </div>
                      )}

                    {activeJob.status === "COMPLETED" && (
                      <div className="job-completed-box">
                        <p className="success-text">
                          Arte renderizada e salva com sucesso!
                        </p>
                        {activeJob.outputMediaUrl && (
                          <div className="completed-output-preview">
                            <img
                              src={activeJob.outputMediaUrl}
                              alt="Arte finalizada"
                              className="completed-img-view"
                            />
                            <div className="completed-actions">
                              <a
                                href={activeJob.outputMediaUrl}
                                download={`arte-${activeJob.id}.png`}
                                className="download-btn-link"
                              >
                                Baixar imagem
                              </a>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {activeJob.status === "FAILED" && (
                      <div className="job-failed-box">
                        <p className="error-text">
                          Não foi possível renderizar a arte.
                        </p>
                        {activeJob.errorCode && (
                          <p className="error-code-badge">
                            Código: {activeJob.errorCode}
                          </p>
                        )}
                        <p className="muted">
                          Verifique as imagens de fundo ou logotipo e tente
                          novamente.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* 3. Histórico de Artes Recentes */}
      <div className="artwork-history-section">
        <div className="history-header">
          <h3>Artes recentes</h3>
          <span className="muted">
            Histórico de renderizações deste cliente
          </span>
        </div>

        {loadingHistory ? (
          <p role="status" className="empty">
            Carregando histórico…
          </p>
        ) : history.length === 0 ? (
          <p className="empty">Nenhuma arte gerada ainda para este cliente.</p>
        ) : (
          <div className="history-cards-grid">
            {history.map((item) => (
              <article key={item.id} className="history-job-card">
                <div className="history-card-header">
                  <span
                    className={`status-badge ${formatStatusClass(item.status)}`}
                  >
                    {formatStatusLabel(item.status)}
                  </span>
                  <small className="muted">{formatDate(item.createdAt)}</small>
                </div>

                <div className="history-card-body">
                  {item.outputMediaUrl ? (
                    <div className="history-thumb-wrapper">
                      <img
                        src={item.outputMediaUrl}
                        alt="Arte gerada"
                        className="history-thumb"
                      />
                    </div>
                  ) : (
                    <div className="history-placeholder-box">
                      <span>
                        {item.status === "FAILED"
                          ? "Falha na geração"
                          : "Processando…"}
                      </span>
                    </div>
                  )}

                  <div className="history-details">
                    <span className="history-attempt muted">
                      Tentativa {item.attemptNumber}
                    </span>
                    {item.errorCode && (
                      <span className="history-error-code">
                        {item.errorCode}
                      </span>
                    )}
                  </div>
                </div>

                {item.outputMediaUrl && (
                  <div className="history-card-footer">
                    <a
                      href={item.outputMediaUrl}
                      download={`arte-${item.id}.png`}
                      className="quiet"
                    >
                      Baixar
                    </a>
                    <a
                      href={item.outputMediaUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="quiet"
                    >
                      Visualizar
                    </a>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}

        {historyHasMore && historyCursor && (
          <div className="load-more-row">
            <button
              type="button"
              className="quiet"
              onClick={() => void loadHistory(historyCursor)}
              disabled={loadingHistory}
            >
              Carregar mais artes
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
