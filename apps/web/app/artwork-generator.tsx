"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DesignFormat, DesignTemplateSpec } from "@socialflow/contracts";
import {
  ArtworkPollingController,
  type PollingJob,
} from "./artwork-polling-controller";

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

export type RenderJobItem = PollingJob;

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

  // Biblioteca de Mídias para Seleção com estados explícitos
  const [mediaAssets, setMediaAssets] = useState<MediaAssetSummary[]>([]);
  const [mediaStatus, setMediaStatus] = useState<
    "loading" | "available" | "unavailable" | "empty" | "error"
  >("loading");
  const [mediaError, setMediaError] = useState<string | null>(null);
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

  // Refs de controle de ciclo de vida e montagem
  const isMountedRef = useRef(true);

  // Callback de recarga do histórico para o controlador de polling
  const loadHistoryRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const onArtworkCompletedRef = useRef(onArtworkCompleted);
  useEffect(() => {
    onArtworkCompletedRef.current = onArtworkCompleted;
  }, [onArtworkCompleted]);

  // Controlador de ciclo de vida de polling
  const controllerRef = useRef<ArtworkPollingController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new ArtworkPollingController({
      fetchJob: async (jobId, signal) => {
        return requestApi<RenderJobItem>(
          `${renderJobsBase}/${encodeURIComponent(jobId)}`,
          undefined,
          signal,
        );
      },
      onJobUpdated: (job) => {
        if (!isMountedRef.current) return;
        setActiveJob(job);
        setHistory((prev) => {
          const idx = prev.findIndex((item) => item.id === job.id);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = job;
            return copy;
          }
          return [job, ...prev];
        });
      },
      onJobCompleted: () => {
        if (!isMountedRef.current) return;
        setPollingTimeoutReached(false);
        setGeneralNotice(
          "Arte gerada com sucesso! A imagem também foi adicionada à sua Biblioteca de Imagens.",
        );
        onArtworkCompletedRef.current?.();
        void loadHistoryRef.current();
      },
      onJobFailed: () => {
        if (!isMountedRef.current) return;
        setPollingTimeoutReached(false);
      },
      onTimeoutReached: () => {
        if (!isMountedRef.current) return;
        setPollingTimeoutReached(true);
      },
    });
  }

  // Desmontagem: limpa recursos e cancela timers/requisições
  useEffect(() => {
    isMountedRef.current = true;
    const controller = controllerRef.current;
    return () => {
      isMountedRef.current = false;
      controller?.dispose();
    };
  }, []);

  // Quando trocar de cliente ou organização: cancela polling, reseta formulário e estados
  useEffect(() => {
    controllerRef.current?.stopPolling();
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
    setMediaAssets([]);
    setMediaStatus("loading");
    setMediaError(null);
  }, [org, clientId]);

  // Carrega templates ativos com deduplicação por ID
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

        setTemplates((prev) => {
          if (!cursor) return data.items;
          const existingIds = new Set(prev.map((t) => t.id));
          const fresh = data.items.filter((t) => !existingIds.has(t.id));
          return [...prev, ...fresh];
        });
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

  // Carrega histórico de renderizações com deduplicação por ID
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

        setHistory((prev) => {
          if (!cursor) return data.items;
          const existingIds = new Set(prev.map((h) => h.id));
          const fresh = data.items.filter((h) => !existingIds.has(h.id));
          return [...prev, ...fresh];
        });
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

  useEffect(() => {
    loadHistoryRef.current = loadHistory;
  }, [loadHistory]);

  // Carrega mídias com estados explícitos (available, unavailable, empty, error) e deduplicação
  const loadMedia = useCallback(
    async (pageToLoad = 1) => {
      try {
        setLoadingMedia(true);
        setMediaError(null);
        const url = `${mediaBase}?page=${pageToLoad}`;
        const data = await requestApi<{
          items: MediaAssetSummary[];
          hasMore: boolean;
          available: boolean;
        }>(url);

        if (!isMountedRef.current) return;

        if (!data.available) {
          setMediaStatus("unavailable");
          setMediaAssets([]);
          setMediaHasMore(false);
          return;
        }

        setMediaAssets((prev) => {
          if (pageToLoad === 1) return data.items;
          const existingIds = new Set(prev.map((m) => m.id));
          const fresh = data.items.filter((m) => !existingIds.has(m.id));
          return [...prev, ...fresh];
        });
        setMediaHasMore(data.hasMore);
        setMediaPage(pageToLoad);
        setMediaStatus(
          data.items.length === 0 && pageToLoad === 1 ? "empty" : "available",
        );
      } catch (err: unknown) {
        if (!isMountedRef.current) return;
        const msg =
          (err as Error).message ??
          "Não foi possível carregar as imagens da biblioteca.";
        setMediaError(msg);
        setMediaStatus("error");
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

  // Requisito 9: Ao trocar de modelo, limpa valores incompatíveis com as flags do novo template
  useEffect(() => {
    if (!currentSpec) return;
    if (!currentSpec.showEyebrow) {
      setEyebrow("");
    }
    if (!currentSpec.showSubtitle) {
      setSubtitle("");
    }
    if (!currentSpec.showCallToAction) {
      setCallToAction("");
    }
  }, [currentSpec]);

  // Mapa local memoizado para resolver nome e formato de template no histórico (sem requisições extras)
  const versionMap = useMemo(() => {
    const map = new Map<string, { name: string; format: DesignFormat }>();
    for (const tpl of templates) {
      if (tpl.latestVersion) {
        map.set(tpl.latestVersion.id, {
          name: tpl.name,
          format: tpl.latestVersion.format,
        });
      }
    }
    if (selectedDetail) {
      for (const ver of selectedDetail.versions) {
        map.set(ver.id, {
          name: selectedDetail.name,
          format: ver.format,
        });
      }
    }
    return map;
  }, [templates, selectedDetail]);

  // Se qualquer campo do formulário mudar após uma tentativa, gera uma nova chave de idempotência
  const handleInputChange = useCallback(
    <T,>(setter: (val: T) => void, val: T) => {
      setter(val);
      setIdempotencyKey(crypto.randomUUID());
      setGeneralError("");
    },
    [],
  );

  // Troca de modelo: cancela polling anterior e gera nova intenção
  function handleSelectTemplate(templateId: string) {
    controllerRef.current?.stopPolling();
    setActiveJob(null);
    setPollingTimeoutReached(false);
    setSelectedTemplateId(templateId);
    setIdempotencyKey(crypto.randomUUID());
    setGeneralError("");
    setGeneralNotice("");
  }

  // Inicializa modelos padrão (OWNER ou ADMIN) - contrato /default retorna array direto
  async function handleInitializeDefaults() {
    try {
      setInitializingDefaults(true);
      setGeneralError("");
      setGeneralNotice("");

      await requestApi<DesignTemplateListItem[]>(`${templatesBase}/default`, {
        method: "POST",
      });

      setGeneralNotice("Modelos padrão inicializados com sucesso!");
      await loadTemplates();
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    } finally {
      if (isMountedRef.current) {
        setInitializingDefaults(false);
      }
    }
  }

  // Consulta manual caso o polling atinja o limite ou usuário solicite
  async function handleManualStatusCheck() {
    if (!activeJob || refreshingJob) return;
    try {
      setRefreshingJob(true);
      setGeneralError("");
      await controllerRef.current?.executeManualCheck(activeJob.id);
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    } finally {
      if (isMountedRef.current) {
        setRefreshingJob(false);
      }
    }
  }

  // Verifica se o formulário está bloqueado por job ativo em andamento
  const isJobProcessing =
    activeJob?.status === "PENDING" || activeJob?.status === "PROCESSING";

  // Submissão do formulário para geração da arte
  async function handleSubmitArtwork(e: React.FormEvent) {
    e.preventDefault();

    if (!canGenerate) {
      setGeneralError("Seu perfil não possui permissão para gerar artes.");
      return;
    }

    if (isJobProcessing) {
      setGeneralError(
        "Há uma arte em processamento. Aguarde a conclusão ou clique em 'Nova arte'.",
      );
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

    if (submitting) return;

    setSubmitting(true);
    setGeneralError("");
    setGeneralNotice("");
    setPollingTimeoutReached(false);

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
      setHistory((prev) => {
        const exists = prev.some((item) => item.id === job.id);
        return exists
          ? prev.map((item) => (item.id === job.id ? job : item))
          : [job, ...prev];
      });

      if (job.status === "PENDING" || job.status === "PROCESSING") {
        controllerRef.current?.startPolling(job.id);
      } else if (job.status === "COMPLETED") {
        controllerRef.current?.handleJobCompletion(job);
      }
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    } finally {
      if (isMountedRef.current) {
        setSubmitting(false);
      }
    }
  }

  // Iniciar nova arte: cancela o acompanhamento visual local sem abortar o job no servidor
  function handleStartNewArtwork() {
    controllerRef.current?.stopPolling();
    setActiveJob(null);
    setPollingTimeoutReached(false);
    setIdempotencyKey(crypto.randomUUID());
    setTitle("");
    setEyebrow("");
    setSubtitle("");
    setCallToAction("");
    setBackgroundMediaAssetId(null);
    setLogoMediaAssetId(null);
    setGeneralNotice("");
    setGeneralError("");
  }

  // URLs de imagens autenticadas para a prévia
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
                  onClick={() => handleSelectTemplate(tpl.id)}
                  onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      handleSelectTemplate(tpl.id);
                    }
                  }}
                >
                  <div className="template-card-top">
                    <span className="template-format-badge">
                      {meta?.label ?? format}
                    </span>
                    <span className="template-version-badge">
                      v{tpl.latestVersion?.version ?? 1}
                    </span>
                  </div>
                  <h4 className="template-name">{tpl.name}</h4>
                  <p className="template-dims muted">
                    {meta?.dimensions ?? "1080 × 1080"}
                  </p>
                  <div
                    className="template-aspect-box"
                    style={{ aspectRatio: meta?.ratio ?? "1 / 1" }}
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

          {/* 2. Workspace de Criação (Formulário + Prévia) */}
          {selectedTemplateId && (
            <div className="artwork-workspace-grid">
              {/* Coluna Esquerda: Formulário de Entrada */}
              <div className="artwork-form-container">
                <div className="form-header">
                  <h3>Conteúdo da arte</h3>
                  <p className="muted">
                    Preencha os textos e escolha as imagens complementares da
                    sua biblioteca.
                  </p>
                </div>

                {!canGenerate ? (
                  <div className="readonly-notice-box">
                    <p>
                      <strong>Modo somente leitura</strong>: seu perfil possui
                      permissão para visualizar modelos e histórico, mas não
                      para gerar novas artes.
                    </p>
                  </div>
                ) : loadingDetail ? (
                  <p role="status" className="empty">
                    Carregando detalhes do modelo…
                  </p>
                ) : (
                  <form onSubmit={handleSubmitArtwork} className="artwork-form">
                    {/* Aviso se houver renderização em andamento */}
                    {isJobProcessing && (
                      <div className="active-render-alert" role="status">
                        <p>
                          <strong>Renderização em andamento:</strong> os campos
                          estão bloqueados enquanto a arte é gerada.
                        </p>
                        <button
                          type="button"
                          className="quiet"
                          onClick={handleStartNewArtwork}
                        >
                          Nova arte
                        </button>
                      </div>
                    )}

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
                          disabled={isJobProcessing}
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
                        disabled={isJobProcessing}
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
                          disabled={isJobProcessing}
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
                          disabled={isJobProcessing}
                        />
                        <small className="help">
                          Opcional. Até 40 caracteres.
                        </small>
                      </div>
                    )}

                    {/* Estados e Seletor de Imagem de Fundo */}
                    <div className="field-group">
                      <label id={`${idPrefix}-bg-label`}>Imagem de fundo</label>
                      <small className="help">
                        Selecione uma imagem da sua biblioteca ou use apenas as
                        cores do modelo.
                      </small>

                      {mediaStatus === "unavailable" && (
                        <p role="status" className="notice">
                          Armazenamento de imagens temporariamente indisponível.
                          Você ainda pode gerar artes utilizando as cores do
                          modelo.
                        </p>
                      )}

                      {mediaStatus === "error" && (
                        <div role="alert" className="error-box">
                          <p>
                            Não foi possível carregar as imagens da biblioteca.
                            {mediaError ? ` (${mediaError})` : ""}
                          </p>
                          <button
                            type="button"
                            className="quiet"
                            onClick={() => void loadMedia(1)}
                            disabled={loadingMedia}
                          >
                            Tentar novamente
                          </button>
                        </div>
                      )}

                      {mediaStatus === "empty" && (
                        <p className="muted">
                          Nenhuma imagem encontrada na biblioteca deste cliente.
                          Você pode usar as cores do modelo ou adicionar imagens
                          na Biblioteca acima.
                        </p>
                      )}

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
                          disabled={isJobProcessing}
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
                              disabled={isJobProcessing}
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
                      {mediaHasMore &&
                        mediaStatus !== "unavailable" &&
                        mediaStatus !== "error" && (
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
                          disabled={isJobProcessing}
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
                              disabled={isJobProcessing}
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

                    {/* Resumo da Geração */}
                    <div className="artwork-summary-card">
                      <h4>Resumo da arte</h4>
                      <ul>
                        <li>
                          Formato:{" "}
                          <strong>
                            {FORMAT_METADATA[currentFormat]?.label} (
                            {FORMAT_METADATA[currentFormat]?.dimensions})
                          </strong>
                        </li>
                        <li>
                          Modelo:{" "}
                          <strong>
                            {selectedDetail?.name ?? "Carregando…"}
                          </strong>
                        </li>
                        <li>
                          Fundo:{" "}
                          {backgroundMediaAssetId
                            ? (mediaAssets.find(
                                (m) => m.id === backgroundMediaAssetId,
                              )?.name ?? "Imagem selecionada")
                            : "Cor do modelo"}
                        </li>
                        <li>
                          Logotipo:{" "}
                          {logoMediaAssetId
                            ? (mediaAssets.find(
                                (m) => m.id === logoMediaAssetId,
                              )?.name ?? "Logotipo selecionado")
                            : "Nenhum"}
                        </li>
                      </ul>
                    </div>

                    {/* Ações do Formulário */}
                    <div className="form-actions">
                      <button
                        type="submit"
                        disabled={
                          submitting ||
                          isJobProcessing ||
                          !title.trim() ||
                          !latestVersion
                        }
                      >
                        {submitting
                          ? "Enviando…"
                          : isJobProcessing
                            ? "Geração em andamento…"
                            : "Gerar arte"}
                      </button>

                      {activeJob && (
                        <button
                          type="button"
                          className="quiet"
                          onClick={handleStartNewArtwork}
                        >
                          Nova arte
                        </button>
                      )}
                    </div>
                  </form>
                )}
              </div>

              {/* Coluna Direita: Prévia Segura e Status de Renderização */}
              <div className="artwork-preview-container">
                <div className="preview-header">
                  <h3>Prévia do modelo</h3>
                  <span className="muted">
                    {FORMAT_METADATA[currentFormat]?.label} (
                    {FORMAT_METADATA[currentFormat]?.dimensions})
                  </span>
                </div>

                {/*
                  Container com proporção correta.
                  Nota de segurança: Estilos inline utilizam estritamente valores validados do DesignTemplateSpec
                  (cores hexadecimais, opacidade numérica, safe area e line-clamp). Textos fornecidos pelo usuário
                  são renderizados exclusivamente como nós de texto comuns do React, sem dangerouslySetInnerHTML,
                  sem interpretação de tags HTML e sem interpolação de texto de usuário em propriedades de estilo.
                */}
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

                    {/* Sobreposição de Cor e Opacidade com valores validados do spec */}
                    <div
                      className="preview-overlay-layer"
                      style={{
                        backgroundColor: currentSpec?.overlayColor ?? "#000000",
                        opacity: currentSpec?.overlayOpacity ?? 0.3,
                      }}
                    />

                    {/* Conteúdo textual seguro (renderizado puramente como string React) */}
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

                    <div className="job-status-footer-actions">
                      <button
                        type="button"
                        className="quiet"
                        onClick={handleStartNewArtwork}
                      >
                        Nova arte
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* 3. Histórico de Artes Recentes com Mapeamento de Nome e Formato */}
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
            {history.map((item) => {
              const mappedModel = versionMap.get(item.templateVersionId);

              return (
                <article key={item.id} className="history-job-card">
                  <div className="history-card-header">
                    <span
                      className={`status-badge ${formatStatusClass(item.status)}`}
                    >
                      {formatStatusLabel(item.status)}
                    </span>
                    <small className="muted">
                      {formatDate(item.createdAt)}
                    </small>
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
                      {mappedModel && (
                        <p className="history-model-info">
                          <strong>{mappedModel.name}</strong> ·{" "}
                          {FORMAT_METADATA[mappedModel.format].label} (
                          {FORMAT_METADATA[mappedModel.format].dimensions})
                        </p>
                      )}
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
              );
            })}
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
