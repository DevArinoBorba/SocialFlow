"use client";

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  type DesignFormat,
  type DesignTemplateSpec,
  calculateLayoutBudget,
  type LayoutBudgetResult,
} from "@socialflow/contracts";
import { ArtworkPreview, FORMAT_DETAILS } from "./artwork-preview";
import {
  analyzeTemplateContrast,
  type DesignContrastAnalysis,
} from "./design-contrast";
import { describeTemplateDifferences, areSpecsEqual } from "./design-diff";
import {
  type ConflictState,
  canReapplyConflict,
  canDiscardConflict,
  validateVersionSubmission,
  TemplateDetailLifecycleController,
} from "./design-template-concurrency";

export interface DesignTemplateManagerProps {
  org: string;
  clientId: string;
  canEditTemplates: boolean;
  canReactivateTemplates: boolean;
  canInitializeTemplates: boolean;
  onTemplatesModified?: () => void;
}

export interface TemplateVersionSummary {
  id: string;
  version: number;
  format: DesignFormat;
  specHash: string;
  rendererVersion: string;
  createdAt: string;
}

export interface TemplateListItem {
  id: string;
  name: string;
  systemKey: string | null;
  status: "ACTIVE" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
  latestVersion: TemplateVersionSummary | null;
}

export interface TemplateVersionDetail {
  id: string;
  version: number;
  format: DesignFormat;
  spec: DesignTemplateSpec;
  specHash: string;
  rendererVersion: string;
  createdAt: string;
}

export interface TemplateDetail {
  id: string;
  name: string;
  systemKey: string | null;
  status: "ACTIVE" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
  versions: TemplateVersionDetail[];
}

const disallowedPattern =
  /<[a-zA-Z/][^>]*>|(?:https?|ftp|file|javascript|data):|(?:url\(|@import|expression\()/i;

function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 120) {
    return "O nome deve ter entre 2 e 120 caracteres.";
  }
  if (disallowedPattern.test(trimmed)) {
    return "O nome não pode conter HTML, CSS, URLs ou scripts.";
  }
  return null;
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
  const res = await fetch(url, {
    ...options,
    signal,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(
      data.message ??
        "Não foi possível concluir a solicitação. Tente novamente.",
    );
    (error as unknown as { status: number }).status = res.status;
    throw error;
  }
  return data as T;
}

const DEFAULT_SPEC: DesignTemplateSpec = {
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

const SIMULATION_TEXTS = {
  short: {
    eyebrow: "Novidade",
    title: "Título Curto",
    subtitle: "Texto breve para demonstração do modelo.",
    cta: "Saiba mais",
  },
  medium: {
    eyebrow: "Destaque Editorial",
    title: "Composição Equilibrada com Tipografia Moderna",
    subtitle:
      "Demonstração com duas ou três linhas de conteúdo descritivo para avaliar alinhamento e proporções.",
    cta: "Acessar conteúdo",
  },
  limit: {
    eyebrow: "Alerta de Limite Textual Extenso",
    title:
      "Este é um título deliberadamente longo concebido para testar o comportamento do limite de linhas do modelo no SocialFlow",
    subtitle:
      "Um subtítulo com texto substancialmente maior para verificar a segurança do espaçamento vertical e evitar que os elementos visuais sofram truncamento indesejado.",
    cta: "Agendar publicação agora",
  },
};

function LayoutBudgetCard({
  layoutBudget,
}: {
  layoutBudget: LayoutBudgetResult;
}) {
  return (
    <div className="layout-budget-card" data-testid="layout-budget-card">
      <div className="layout-budget-header">
        <h4>Orçamento Vertical e Área Útil (Estimativa)</h4>
        <span
          className={
            layoutBudget.status === "safe"
              ? "budget-badge-safe"
              : layoutBudget.status === "warning"
                ? "budget-badge-warning"
                : "budget-badge-overflow"
          }
          data-testid={`budget-status-${layoutBudget.status}`}
        >
          {layoutBudget.status === "safe"
            ? "Seguro"
            : layoutBudget.status === "warning"
              ? "Próximo do Limite"
              : "Risco de Corte"}
        </span>
      </div>

      <div className="budget-metrics-grid">
        <div>
          <span className="muted">Altura total:</span>{" "}
          <strong>{layoutBudget.totalHeight} px</strong>
        </div>
        <div>
          <span className="muted">Safe area:</span>{" "}
          <strong>{layoutBudget.safeAreaTotal} px (2×)</strong>
        </div>
        <div>
          <span className="muted">Área útil disponível:</span>{" "}
          <strong>{layoutBudget.availableHeight} px</strong>
        </div>
        <div>
          <span className="muted">Conteúdo estimado:</span>{" "}
          <strong>{layoutBudget.usedHeight} px</strong>
        </div>
        <div>
          <span className="muted">Espaço restante:</span>{" "}
          <strong
            style={{
              color: layoutBudget.remainingHeight < 0 ? "#b91c1c" : "inherit",
            }}
          >
            {layoutBudget.remainingHeight} px
          </strong>
        </div>
      </div>

      {layoutBudget.explanation && (
        <p className="small muted" style={{ margin: "6px 0 0" }}>
          {layoutBudget.explanation}
        </p>
      )}

      <p
        className="small muted"
        style={{ fontSize: "11px", margin: "4px 0 0" }}
      >
        Estimativa conservadora baseada nas regras de entrelinha e altura do
        renderer. A renderização final no worker pode variar conforme o texto
        exato.
      </p>

      {layoutBudget.responsibleBlocks.length > 0 && (
        <ul className="budget-warning-list" data-testid="budget-warning-list">
          {layoutBudget.responsibleBlocks.map((b: string, idx: number) => (
            <li key={idx}>Bloco causador de risco: {b}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DesignTemplateManager({
  org,
  clientId,
  canEditTemplates,
  canReactivateTemplates,
  canInitializeTemplates,
  onTemplatesModified,
}: DesignTemplateManagerProps) {
  const idPrefix = useId();
  const templatesBase = `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}/design-templates`;

  // Estados da Listagem
  const [templates, setTemplates] = useState<TemplateListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"ACTIVE" | "ARCHIVED">(
    "ACTIVE",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Estados de Visualização e Detalhe
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null,
  );
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [previewVersionIndex, setPreviewVersionIndex] = useState<number | null>(
    null,
  );

  // Modos de Ação
  const [viewMode, setViewMode] = useState<"list" | "detail" | "create">(
    "list",
  );
  const [isEditingVersion, setIsEditingVersion] = useState(false);

  // Estado do Formulário de Criação
  const [createName, setCreateName] = useState("");
  const [createSpec, setCreateSpec] =
    useState<DesignTemplateSpec>(DEFAULT_SPEC);
  const [creating, setCreating] = useState(false);

  // Estado de Edição de Versão e Concorrência Otimista
  const [editSpec, setEditSpec] = useState<DesignTemplateSpec>(DEFAULT_SPEC);
  const [baseVersionNumber, setBaseVersionNumber] = useState<number | null>(
    null,
  );
  const [baseSpec, setBaseSpec] = useState<DesignTemplateSpec | null>(null);
  const [savingVersion, setSavingVersion] = useState(false);
  const [isReappliedDirty, setIsReappliedDirty] = useState(false);

  // Conflito de Concorrência Otimista (409)
  const [conflictState, setConflictState] = useState<ConflictState | null>(
    null,
  );

  const lifecycleRef = useRef<TemplateDetailLifecycleController | null>(null);
  if (!lifecycleRef.current) {
    lifecycleRef.current = new TemplateDetailLifecycleController(org, clientId);
  }
  useEffect(() => {
    lifecycleRef.current?.updateContext(org, clientId, selectedTemplateId);
  }, [org, clientId, selectedTemplateId]);

  useEffect(() => {
    return () => {
      lifecycleRef.current?.abortAll("Component unmounted");
    };
  }, []);

  // Confirmação Explícita de Contraste Reprovado (WCAG)
  const [contrastConfirmDialog, setContrastConfirmDialog] = useState<{
    isOpen: boolean;
    failedElements: Array<{
      label: string;
      ratio: string;
      explanation: string;
      statusLabel: string;
    }>;
    isEstimated: boolean;
    onConfirm: () => void;
  } | null>(null);

  // Modais de Ação Rápida
  const [duplicatingTemplate, setDuplicatingTemplate] =
    useState<TemplateListItem | null>(null);
  const [duplicateName, setDuplicateName] = useState("");
  const [duplicating, setDuplicating] = useState(false);

  const [renamingTemplate, setRenamingTemplate] =
    useState<TemplateListItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);

  const [archivingTemplate, setArchivingTemplate] =
    useState<TemplateListItem | null>(null);
  const [archiving, setArchiving] = useState(false);

  // Ferramentas de Teste e Prévia
  const [showSafeAreaGuides, setShowSafeAreaGuides] = useState(true);
  const [simulationLength, setSimulationLength] = useState<
    "short" | "medium" | "limit"
  >("medium");

  // Notificações e Erros
  const [generalError, setGeneralError] = useState("");
  const [generalNotice, setGeneralNotice] = useState("");
  const [initializingDefaults, setInitializingDefaults] = useState(false);

  // Detecção de Alterações Não Salvas
  const latestDetailVersion = useMemo(() => {
    if (!detail?.versions?.length) return null;
    return (
      [...detail.versions].sort((a, b) => b.version - a.version)[0] ?? null
    );
  }, [detail]);

  const isVersionDirty = useMemo(() => {
    if (!isEditingVersion || !baseSpec) return false;
    if (conflictState?.hasConflict) return true;
    return isReappliedDirty || !areSpecsEqual(editSpec, baseSpec);
  }, [isEditingVersion, editSpec, baseSpec, isReappliedDirty, conflictState]);

  const isCreateDirty = useMemo(() => {
    if (viewMode !== "create") return false;
    return (
      createName.trim().length > 0 || !areSpecsEqual(createSpec, DEFAULT_SPEC)
    );
  }, [viewMode, createName, createSpec]);

  const hasUnsavedChanges = isVersionDirty || isCreateDirty;

  // Proteção contra perda acidental com beforeunload
  useEffect(() => {
    if (!hasUnsavedChanges) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  // Ref para proteção contra condições de corrida nas requisições do catálogo
  const catalogRequestIdRef = useRef(0);

  // Carrega Catálogo de Templates
  const loadCatalog = useCallback(
    async (nextCursor?: string) => {
      const requestId = ++catalogRequestIdRef.current;
      try {
        setLoadingList(true);
        const searchParam = searchQuery.trim()
          ? `&search=${encodeURIComponent(searchQuery.trim())}`
          : "";
        const cursorParam = nextCursor
          ? `&cursor=${encodeURIComponent(nextCursor)}`
          : "";
        const url = `${templatesBase}?status=${statusFilter}&limit=20${searchParam}${cursorParam}`;
        const data = await requestApi<{
          items: TemplateListItem[];
          nextCursor: string | null;
          hasMore: boolean;
        }>(url);

        if (requestId !== catalogRequestIdRef.current) {
          // Resposta obsoleta descartada
          return;
        }

        setTemplates((prev) => {
          if (!nextCursor) return data.items;
          const ids = new Set(prev.map((t) => t.id));
          return [...prev, ...data.items.filter((t) => !ids.has(t.id))];
        });
        setCursor(data.nextCursor);
        setHasMore(data.hasMore);
      } catch (err: unknown) {
        if (requestId === catalogRequestIdRef.current) {
          setGeneralError((err as Error).message);
        }
      } finally {
        if (requestId === catalogRequestIdRef.current) {
          setLoadingList(false);
        }
      }
    },
    [templatesBase, statusFilter, searchQuery],
  );

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // Carrega Detalhe do Template Selecionado (Normal)
  const loadInitialTemplateDetail = useCallback(
    async (templateId: string) => {
      if (!lifecycleRef.current) return;
      const { signal, requestId, isCurrent } =
        lifecycleRef.current.startDetailRequest(templateId);

      try {
        setLoadingDetail(true);
        setGeneralError("");
        const data = await requestApi<TemplateDetail>(
          `${templatesBase}/${templateId}`,
          {},
          signal,
        );

        if (!isCurrent(requestId)) {
          // Resposta obsoleta descartada
          return;
        }

        setDetail(data);
        setPreviewVersionIndex(null);
        const latest = [...data.versions].sort(
          (a, b) => b.version - a.version,
        )[0];
        if (latest) {
          setBaseVersionNumber(latest.version);
          setBaseSpec(JSON.parse(JSON.stringify(latest.spec)));
          setEditSpec(JSON.parse(JSON.stringify(latest.spec)));
          setConflictState(null);
          setIsEditingVersion(false);
          setIsReappliedDirty(false);
        }
      } catch (err: unknown) {
        if ((err as Error)?.name === "AbortError") {
          return;
        }
        if (isCurrent(requestId)) {
          setGeneralError((err as Error).message);
        }
      } finally {
        if (isCurrent(requestId)) {
          setLoadingDetail(false);
        }
      }
    },
    [templatesBase],
  );

  // Recarrega versão do servidor especificamente durante ou após conflito de concorrência
  const reloadConflictServerVersion = useCallback(
    async (targetTemplateId: string, currentBase: number) => {
      if (!lifecycleRef.current) return;
      const { signal, requestId, isCurrent } =
        lifecycleRef.current.startConflictRequest(targetTemplateId);

      setConflictState((prev) =>
        prev
          ? { ...prev, isLoadingServerVersion: true, fetchError: null }
          : {
              hasConflict: true,
              baseVersionNumber: currentBase,
              serverVersion: null,
              serverSpec: null,
              diffItems: [],
              fetchError: null,
              isLoadingServerVersion: true,
            },
      );

      try {
        const freshDetail = await requestApi<TemplateDetail>(
          `${templatesBase}/${targetTemplateId}`,
          {},
          signal,
        );

        if (!isCurrent(requestId)) {
          // Resposta de conflito obsoleta descartada
          return;
        }

        const serverLatest = [...freshDetail.versions].sort(
          (a, b) => b.version - a.version,
        )[0];

        if (!serverLatest) {
          throw new Error("Nenhuma versão válida encontrada no modelo.");
        }

        const diffs = describeTemplateDifferences(serverLatest.spec, editSpec);

        setConflictState({
          hasConflict: true,
          baseVersionNumber: currentBase,
          serverVersion: serverLatest.version,
          serverSpec: serverLatest.spec,
          diffItems: diffs,
          fetchError: null,
          isLoadingServerVersion: false,
        });

        // Atualiza a listagem de versões do detalhe
        setDetail((prev) =>
          prev?.id === targetTemplateId ? freshDetail : prev,
        );
      } catch (err: unknown) {
        if ((err as Error)?.name === "AbortError") {
          return;
        }
        if (!isCurrent(requestId)) {
          return;
        }

        const msg =
          (err as Error)?.message ||
          "Não foi possível carregar a versão atual do servidor.";

        // NUNCA engole a falha!
        setConflictState((prev) =>
          prev
            ? {
                ...prev,
                fetchError: msg,
                isLoadingServerVersion: false,
              }
            : {
                hasConflict: true,
                baseVersionNumber: currentBase,
                serverVersion: null,
                serverSpec: null,
                diffItems: [],
                fetchError: msg,
                isLoadingServerVersion: false,
              },
        );
        setGeneralError(
          "Conflito de concorrência detectado, mas não foi possível carregar a versão atual do servidor. Verifique sua conexão e tente novamente.",
        );
      }
    },
    [templatesBase, editSpec],
  );

  useEffect(() => {
    if (selectedTemplateId) {
      void loadInitialTemplateDetail(selectedTemplateId);
    } else {
      setDetail(null);
      setConflictState(null);
    }
  }, [selectedTemplateId, loadInitialTemplateDetail]);

  // Navegação Segura com Alerta de Alterações Pendentes
  function confirmDiscardChanges(): boolean {
    if (!hasUnsavedChanges) return true;
    return window.confirm(
      "Você possui alterações não salvas. Deseja realmente descartá-las?",
    );
  }

  function handleSelectTemplate(item: TemplateListItem) {
    if (!confirmDiscardChanges()) return;
    setIsEditingVersion(false);
    setSelectedTemplateId(item.id);
    setViewMode("detail");
  }

  function handleBackToList() {
    if (!confirmDiscardChanges()) return;
    setIsEditingVersion(false);
    setSelectedTemplateId(null);
    setDetail(null);
    setViewMode("list");
  }

  function handleStartCreate() {
    if (!confirmDiscardChanges()) return;
    setCreateName("");
    setCreateSpec({ ...DEFAULT_SPEC });
    setViewMode("create");
    setSelectedTemplateId(null);
  }

  // Inicializar Modelos Padrão do Sistema
  async function handleInitializeDefaults() {
    try {
      setInitializingDefaults(true);
      setGeneralError("");
      setGeneralNotice("");
      await requestApi<TemplateListItem[]>(`${templatesBase}/default`, {
        method: "POST",
      });
      setGeneralNotice("Modelos padrão do sistema inicializados com sucesso.");
      onTemplatesModified?.();
      await loadCatalog();
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    } finally {
      setInitializingDefaults(false);
    }
  }

  // Reaplicar rascunho sobre a versão atual do servidor
  function handleReapplyOverServerVersion() {
    if (!canReapplyConflict(conflictState)) return;
    const { serverVersion, serverSpec } = conflictState!;
    setBaseVersionNumber(serverVersion!);
    setBaseSpec(JSON.parse(JSON.stringify(serverSpec!)));
    setIsReappliedDirty(true);
    setConflictState(null);
    setGeneralNotice(
      `Rascunho mantido e reaplicado sobre a versão ${serverVersion}. Revise e confirme o envio para salvar.`,
    );
  }

  // Descartar rascunho e carregar a versão mais recente do servidor
  function handleDiscardDraft() {
    if (!canDiscardConflict(conflictState)) return;
    const { serverVersion, serverSpec } = conflictState!;
    setEditSpec(JSON.parse(JSON.stringify(serverSpec!)));
    setBaseVersionNumber(serverVersion!);
    setBaseSpec(JSON.parse(JSON.stringify(serverSpec!)));
    setIsReappliedDirty(false);
    setConflictState(null);
    setIsEditingVersion(false);
    setGeneralNotice(
      `Rascunho descartado. O formulário foi atualizado para a versão ${serverVersion}.`,
    );
  }

  async function executeCreate() {
    try {
      setCreating(true);
      setGeneralError("");
      setGeneralNotice("");
      const created = await requestApi<TemplateDetail>(templatesBase, {
        method: "POST",
        body: JSON.stringify({
          name: createName.trim(),
          spec: createSpec,
        }),
      });

      setGeneralNotice(
        `Modelo "${created.name}" criado com sucesso (versão 1).`,
      );
      onTemplatesModified?.();
      await loadCatalog();
      setSelectedTemplateId(created.id);
      setViewMode("detail");
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  // Submeter Criação de Novo Template (Versão 1)
  async function handleSubmitCreate(e: FormEvent) {
    e.preventDefault();
    const nameErr = validateName(createName);
    if (nameErr) {
      setGeneralError(nameErr);
      return;
    }

    if (contrastAnalysis.hasFailure) {
      setContrastConfirmDialog({
        isOpen: true,
        failedElements: contrastAnalysis.failedElements.map((el) => ({
          label: el.label,
          ratio: el.formattedRatio,
          explanation: el.explanation,
          statusLabel: el.statusLabel,
        })),
        isEstimated: contrastAnalysis.isBackgroundEstimated,
        onConfirm: () => {
          setContrastConfirmDialog(null);
          void executeCreate();
        },
      });
      return;
    }

    await executeCreate();
  }

  async function executeSaveVersion() {
    if (!detail || baseVersionNumber === null) return;
    const targetTemplateId = detail.id;
    const currentBaseVersion = baseVersionNumber;

    try {
      setSavingVersion(true);
      setGeneralError("");
      setGeneralNotice("");

      const nextVersion = await requestApi<TemplateVersionDetail>(
        `${templatesBase}/${targetTemplateId}/versions`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedBaseVersion: currentBaseVersion,
            spec: editSpec,
          }),
        },
      );

      setGeneralNotice(
        `Nova versão ${nextVersion.version} criada com sucesso para "${detail.name}".`,
      );
      setIsEditingVersion(false);
      setIsReappliedDirty(false);
      setConflictState(null);
      onTemplatesModified?.();
      await loadInitialTemplateDetail(targetTemplateId);
      await loadCatalog();
    } catch (err: unknown) {
      const errorObj = err as { status?: number; message?: string };
      if (errorObj.status === 409) {
        // Conflito de concorrência: rascunho do usuário (editSpec) preservado integralmente!
        // isEditingVersion e isVersionDirty permanecem ativos.
        setGeneralError(
          "Conflito de concorrência: a versão mais recente do servidor já foi alterada por outro usuário. Nenhuma alteração foi salva. Seu rascunho foi preservado abaixo.",
        );
        await reloadConflictServerVersion(targetTemplateId, currentBaseVersion);
      } else {
        setGeneralError(errorObj.message ?? "Falha ao salvar nova versão.");
      }
    } finally {
      setSavingVersion(false);
    }
  }

  // Submeter Nova Versão Imutável
  async function handleSubmitVersion(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;

    const validation = validateVersionSubmission({
      isEditingVersion,
      isVersionDirty,
      conflictState,
    });

    if (!validation.allowed) {
      setGeneralError(validation.reason ?? "Não é possível salvar.");
      return;
    }

    if (contrastAnalysis.hasFailure) {
      setContrastConfirmDialog({
        isOpen: true,
        failedElements: contrastAnalysis.failedElements.map((el) => ({
          label: el.label,
          ratio: el.formattedRatio,
          explanation: el.explanation,
          statusLabel: el.statusLabel,
        })),
        isEstimated: contrastAnalysis.isBackgroundEstimated,
        onConfirm: () => {
          setContrastConfirmDialog(null);
          void executeSaveVersion();
        },
      });
      return;
    }

    await executeSaveVersion();
  }

  // Duplicar Template
  async function handleConfirmDuplicate(e: FormEvent) {
    e.preventDefault();
    if (!duplicatingTemplate) return;
    const nameErr = validateName(duplicateName);
    if (nameErr) {
      setGeneralError(nameErr);
      return;
    }

    try {
      setDuplicating(true);
      setGeneralError("");
      setGeneralNotice("");

      const duplicated = await requestApi<TemplateDetail>(
        `${templatesBase}/${duplicatingTemplate.id}/duplicate`,
        {
          method: "POST",
          body: JSON.stringify({ name: duplicateName.trim() }),
        },
      );

      setGeneralNotice(
        `Modelo duplicado com sucesso como "${duplicated.name}" (versão 1 ativa).`,
      );
      setDuplicatingTemplate(null);
      setDuplicateName("");
      onTemplatesModified?.();
      await loadCatalog();
      setSelectedTemplateId(duplicated.id);
      setViewMode("detail");
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    } finally {
      setDuplicating(false);
    }
  }

  // Renomear Template
  async function handleConfirmRename(e: FormEvent) {
    e.preventDefault();
    if (!renamingTemplate) return;
    const nameErr = validateName(renameValue);
    if (nameErr) {
      setGeneralError(nameErr);
      return;
    }

    try {
      setRenaming(true);
      setGeneralError("");
      setGeneralNotice("");

      const updated = await requestApi<TemplateDetail>(
        `${templatesBase}/${renamingTemplate.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: renameValue.trim() }),
        },
      );

      setGeneralNotice(`Modelo renomeado para "${updated.name}" com sucesso.`);
      setRenamingTemplate(null);
      setRenameValue("");
      onTemplatesModified?.();
      await loadCatalog();
      if (detail && detail.id === updated.id) {
        setDetail((prev) => (prev ? { ...prev, name: updated.name } : null));
      }
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    } finally {
      setRenaming(false);
    }
  }

  // Arquivar Template
  async function handleConfirmArchive() {
    if (!archivingTemplate) return;
    try {
      setArchiving(true);
      setGeneralError("");
      setGeneralNotice("");

      await requestApi<TemplateDetail>(
        `${templatesBase}/${archivingTemplate.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "ARCHIVED" }),
        },
      );

      setGeneralNotice(`Modelo "${archivingTemplate.name}" arquivado.`);
      setArchivingTemplate(null);
      onTemplatesModified?.();
      await loadCatalog();
      if (detail && detail.id === archivingTemplate.id) {
        setDetail((prev) => (prev ? { ...prev, status: "ARCHIVED" } : null));
      }
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    } finally {
      setArchiving(false);
    }
  }

  // Reativar Template
  async function handleReactivate(templateId: string, templateName: string) {
    try {
      setGeneralError("");
      setGeneralNotice("");
      await requestApi<TemplateDetail>(`${templatesBase}/${templateId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "ACTIVE" }),
      });
      setGeneralNotice(`Modelo "${templateName}" reativado com sucesso.`);
      onTemplatesModified?.();
      await loadCatalog();
      if (detail && detail.id === templateId) {
        setDetail((prev) => (prev ? { ...prev, status: "ACTIVE" } : null));
      }
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    }
  }

  // Análise de Contraste Atual (do formulário ativo ou do detalhe)
  const activeSpecForPreview = useMemo(() => {
    if (viewMode === "create") return createSpec;
    if (isEditingVersion) return editSpec;
    if (
      previewVersionIndex !== null &&
      detail?.versions?.[previewVersionIndex]
    ) {
      return detail.versions[previewVersionIndex].spec;
    }
    return latestDetailVersion?.spec ?? DEFAULT_SPEC;
  }, [
    viewMode,
    createSpec,
    isEditingVersion,
    editSpec,
    previewVersionIndex,
    detail,
    latestDetailVersion,
  ]);

  const activeFormatForPreview = useMemo(() => {
    if (viewMode === "create") return createSpec.format;
    if (
      previewVersionIndex !== null &&
      detail?.versions?.[previewVersionIndex]
    ) {
      return detail.versions[previewVersionIndex].format;
    }
    return latestDetailVersion?.format ?? "SQUARE";
  }, [
    viewMode,
    createSpec.format,
    previewVersionIndex,
    detail,
    latestDetailVersion,
  ]);

  const contrastAnalysis: DesignContrastAnalysis = useMemo(() => {
    return analyzeTemplateContrast({
      backgroundColor: activeSpecForPreview.backgroundColor,
      overlayColor: activeSpecForPreview.overlayColor,
      overlayOpacity: activeSpecForPreview.overlayOpacity,
      textColor: activeSpecForPreview.textColor,
      mutedTextColor: activeSpecForPreview.mutedTextColor,
      accentColor: activeSpecForPreview.accentColor,
      showEyebrow: activeSpecForPreview.showEyebrow,
      showSubtitle: activeSpecForPreview.showSubtitle,
      showCallToAction: activeSpecForPreview.showCallToAction,
      hasBackgroundImage: false,
    });
  }, [activeSpecForPreview]);

  // Análise Determinística de Orçamento Vertical e Safe Area
  const layoutBudget: LayoutBudgetResult = useMemo(() => {
    return calculateLayoutBudget(activeSpecForPreview, {
      textScenario: simulationLength,
      hasLogo: false,
    });
  }, [activeSpecForPreview, simulationLength]);

  // Resumo de Alterações em Relação à Versão-Base
  const pendingChanges = useMemo(() => {
    if (!isEditingVersion || !baseSpec) return [];
    return describeTemplateDifferences(baseSpec, editSpec);
  }, [isEditingVersion, baseSpec, editSpec]);

  // Textos da Simulação de Prévia
  const simText = SIMULATION_TEXTS[simulationLength];

  return (
    <section
      className="design-template-manager-section"
      aria-label="Modelos de design"
    >
      <div className="section-header">
        <div>
          <h2>Modelos de design</h2>
          <p className="muted">
            Catálogo declarativo e versionamento imutável de artes da marca.
          </p>
        </div>

        <div className="section-header-actions">
          {viewMode === "list" && canEditTemplates && (
            <button type="button" onClick={handleStartCreate}>
              Criar modelo
            </button>
          )}

          {viewMode !== "list" && (
            <button type="button" className="quiet" onClick={handleBackToList}>
              ← Voltar ao catálogo
            </button>
          )}
        </div>
      </div>

      {/* Alertas e Mensagens de Status */}
      {generalError && (
        <div className="error-box" role="alert">
          <p>{generalError}</p>
          <button
            type="button"
            className="quiet"
            onClick={() => setGeneralError("")}
          >
            Fechar
          </button>
        </div>
      )}

      {generalNotice && (
        <p className="notice" role="status">
          {generalNotice}
        </p>
      )}

      {/* ========================================================================= */}
      {/* VISÃO 1: CATÁLOGO DE TEMPLATES                                            */}
      {/* ========================================================================= */}
      {viewMode === "list" && (
        <div className="template-catalog-view">
          {/* Barra de Filtros e Busca */}
          <div className="catalog-toolbar">
            <div className="search-field">
              <label htmlFor={`${idPrefix}-search`} className="sr-only">
                Buscar modelos por nome
              </label>
              <input
                id={`${idPrefix}-search`}
                type="search"
                placeholder="Buscar modelo por nome…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                maxLength={100}
              />
            </div>

            <div
              className="status-filter-group"
              role="radiogroup"
              aria-label="Filtrar por status"
            >
              <button
                type="button"
                className={`filter-btn ${statusFilter === "ACTIVE" ? "active" : "quiet"}`}
                onClick={() => setStatusFilter("ACTIVE")}
                aria-pressed={statusFilter === "ACTIVE"}
              >
                Ativos
              </button>
              <button
                type="button"
                className={`filter-btn ${statusFilter === "ARCHIVED" ? "active" : "quiet"}`}
                onClick={() => setStatusFilter("ARCHIVED")}
                aria-pressed={statusFilter === "ARCHIVED"}
              >
                Arquivados
              </button>
            </div>
          </div>

          {/* Estado de Carregamento */}
          {loadingList && (
            <p className="empty" role="status">
              Carregando catálogo de modelos…
            </p>
          )}

          {/* Lista Vazia */}
          {!loadingList && templates.length === 0 && (
            <div className="empty-catalog-card">
              <h3>
                {searchQuery
                  ? "Nenhum modelo encontrado para a busca"
                  : statusFilter === "ARCHIVED"
                    ? "Nenhum modelo arquivado"
                    : "Nenhum modelo ativo cadastrado"}
              </h3>
              <p className="muted">
                {statusFilter === "ACTIVE" && !searchQuery
                  ? canInitializeTemplates
                    ? "Você pode inicializar os modelos padrão sugeridos pelo SocialFlow para começar imediatamente."
                    : "Solicite a um administrador para inicializar ou criar modelos de arte para este cliente."
                  : "Altere os termos da busca ou os filtros para ver outros modelos."}
              </p>

              {statusFilter === "ACTIVE" &&
                !searchQuery &&
                canInitializeTemplates && (
                  <button
                    type="button"
                    onClick={handleInitializeDefaults}
                    disabled={initializingDefaults}
                  >
                    {initializingDefaults
                      ? "Inicializando…"
                      : "Inicializar modelos padrão"}
                  </button>
                )}
            </div>
          )}

          {/* Grid de Cards de Templates */}
          {!loadingList && templates.length > 0 && (
            <div className="template-cards-grid">
              {templates.map((tpl) => {
                const latest = tpl.latestVersion;
                const formatInfo = latest
                  ? FORMAT_DETAILS[latest.format]
                  : null;

                return (
                  <article
                    key={tpl.id}
                    className={`template-card status-${tpl.status.toLowerCase()}`}
                  >
                    <div className="template-card-header">
                      <div className="template-title-row">
                        <h4>{tpl.name}</h4>
                        {tpl.systemKey && (
                          <span
                            className="system-badge"
                            title="Modelo original do sistema (systemKey imutável)"
                          >
                            Modelo inicial
                          </span>
                        )}
                      </div>
                      <span
                        className={`badge ${tpl.status === "ACTIVE" ? "badge-active" : "badge-archived"}`}
                      >
                        {tpl.status === "ACTIVE" ? "Ativo" : "Arquivado"}
                      </span>
                    </div>

                    <div className="template-card-meta">
                      {formatInfo && (
                        <span className="format-tag">
                          {formatInfo.label} ({formatInfo.dimensions})
                        </span>
                      )}
                      {latest && (
                        <span className="version-tag">
                          Versão {latest.version}
                        </span>
                      )}
                    </div>

                    <div className="template-card-actions">
                      <button
                        type="button"
                        className="action-btn"
                        onClick={() => handleSelectTemplate(tpl)}
                      >
                        Visualizar
                      </button>

                      {canEditTemplates && tpl.status === "ACTIVE" && (
                        <>
                          <button
                            type="button"
                            className="quiet"
                            onClick={() => {
                              handleSelectTemplate(tpl);
                              setIsEditingVersion(true);
                            }}
                          >
                            Editar versão
                          </button>
                          <button
                            type="button"
                            className="quiet"
                            onClick={() => {
                              setDuplicatingTemplate(tpl);
                              setDuplicateName(`${tpl.name} (Cópia)`);
                            }}
                          >
                            Duplicar
                          </button>
                          <button
                            type="button"
                            className="quiet"
                            onClick={() => {
                              setRenamingTemplate(tpl);
                              setRenameValue(tpl.name);
                            }}
                          >
                            Renomear
                          </button>
                          <button
                            type="button"
                            className="quiet danger"
                            onClick={() => setArchivingTemplate(tpl)}
                          >
                            Arquivar
                          </button>
                        </>
                      )}

                      {canReactivateTemplates && tpl.status === "ARCHIVED" && (
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => handleReactivate(tpl.id, tpl.name)}
                        >
                          Reativar
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {/* Paginação */}
          {hasMore && (
            <div className="pagination-row">
              <button
                type="button"
                className="quiet"
                onClick={() => cursor && loadCatalog(cursor)}
                disabled={loadingList}
              >
                {loadingList ? "Carregando…" : "Carregar mais modelos"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* VISÃO 2: CRIAÇÃO DE NOVO TEMPLATE                                         */}
      {/* ========================================================================= */}
      {viewMode === "create" && (
        <div className="template-editor-layout">
          {/* Coluna Esquerda: Formulário de Criação */}
          <div className="editor-form-column">
            <div className="editor-form-header">
              <h3>Criar novo modelo de design</h3>
              <p className="muted">
                Defina o formato e a composição visual da versão 1.
              </p>
            </div>

            <form onSubmit={handleSubmitCreate} className="template-form">
              <div className="form-group">
                <label htmlFor={`${idPrefix}-create-name`}>
                  Nome do modelo *
                </label>
                <input
                  id={`${idPrefix}-create-name`}
                  type="text"
                  required
                  minLength={2}
                  maxLength={120}
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="Ex.: Minimalista Promocional"
                />
                <small className="help-text">
                  Nome claro para identificação no Gerador de Artes (2 a 120
                  caracteres).
                </small>
              </div>

              <div className="form-group">
                <label htmlFor={`${idPrefix}-create-format`}>Formato *</label>
                <select
                  id={`${idPrefix}-create-format`}
                  value={createSpec.format}
                  onChange={(e) =>
                    setCreateSpec((prev) => ({
                      ...prev,
                      format: e.target.value as DesignFormat,
                    }))
                  }
                >
                  <option value="SQUARE">
                    Quadrado (1080 × 1080 px) - Feed
                  </option>
                  <option value="PORTRAIT">
                    Retrato (1080 × 1350 px) - Feed Vertical
                  </option>
                  <option value="STORY">
                    Story (1080 × 1920 px) - Vertical Cheio
                  </option>
                </select>
              </div>

              {/* Família Tipográfica (Somente Leitura) */}
              <div className="form-group">
                <label htmlFor={`${idPrefix}-create-font`}>Tipografia</label>
                <select id={`${idPrefix}-create-font`} disabled value="Inter">
                  <option value="Inter">
                    Inter (Família Aprovada e Empacotada)
                  </option>
                </select>
                <small className="help-text">
                  A tipografia é padronizada com a fonte oficial Inter para
                  assegurar renderização determinística e conformidade de
                  licença.
                </small>
              </div>

              {/* Controles de Cores */}
              <div className="colors-grid-section">
                <h4>Paleta de Cores</h4>
                <p className="muted small">
                  As cores são configuradas manualmente de forma declarativa.
                </p>

                <div className="color-fields-grid">
                  <div className="color-field">
                    <label htmlFor={`${idPrefix}-create-bg`}>Fundo</label>
                    <div className="color-input-wrapper">
                      <input
                        type="color"
                        id={`${idPrefix}-create-bg`}
                        value={createSpec.backgroundColor}
                        onChange={(e) =>
                          setCreateSpec((prev) => ({
                            ...prev,
                            backgroundColor: e.target.value.toUpperCase(),
                          }))
                        }
                      />
                      <code>{createSpec.backgroundColor}</code>
                    </div>
                  </div>

                  <div className="color-field">
                    <label htmlFor={`${idPrefix}-create-overlay`}>
                      Sobreposição
                    </label>
                    <div className="color-input-wrapper">
                      <input
                        type="color"
                        id={`${idPrefix}-create-overlay`}
                        value={createSpec.overlayColor}
                        onChange={(e) =>
                          setCreateSpec((prev) => ({
                            ...prev,
                            overlayColor: e.target.value.toUpperCase(),
                          }))
                        }
                      />
                      <code>{createSpec.overlayColor}</code>
                    </div>
                  </div>

                  <div className="color-field">
                    <label htmlFor={`${idPrefix}-create-text`}>
                      Texto Principal
                    </label>
                    <div className="color-input-wrapper">
                      <input
                        type="color"
                        id={`${idPrefix}-create-text`}
                        value={createSpec.textColor}
                        onChange={(e) =>
                          setCreateSpec((prev) => ({
                            ...prev,
                            textColor: e.target.value.toUpperCase(),
                          }))
                        }
                      />
                      <code>{createSpec.textColor}</code>
                    </div>
                  </div>

                  <div className="color-field">
                    <label htmlFor={`${idPrefix}-create-muted`}>
                      Texto Secundário
                    </label>
                    <div className="color-input-wrapper">
                      <input
                        type="color"
                        id={`${idPrefix}-create-muted`}
                        value={createSpec.mutedTextColor}
                        onChange={(e) =>
                          setCreateSpec((prev) => ({
                            ...prev,
                            mutedTextColor: e.target.value.toUpperCase(),
                          }))
                        }
                      />
                      <code>{createSpec.mutedTextColor}</code>
                    </div>
                  </div>

                  <div className="color-field">
                    <label htmlFor={`${idPrefix}-create-accent`}>
                      Destaque / CTA
                    </label>
                    <div className="color-input-wrapper">
                      <input
                        type="color"
                        id={`${idPrefix}-create-accent`}
                        value={createSpec.accentColor}
                        onChange={(e) =>
                          setCreateSpec((prev) => ({
                            ...prev,
                            accentColor: e.target.value.toUpperCase(),
                          }))
                        }
                      />
                      <code>{createSpec.accentColor}</code>
                    </div>
                  </div>
                </div>

                {/* Opacidade da Sobreposição */}
                <div className="slider-field">
                  <div className="slider-label-row">
                    <label htmlFor={`${idPrefix}-create-opacity`}>
                      Opacidade da sobreposição
                    </label>
                    <span>{Math.round(createSpec.overlayOpacity * 100)}%</span>
                  </div>
                  <input
                    id={`${idPrefix}-create-opacity`}
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={createSpec.overlayOpacity}
                    onChange={(e) =>
                      setCreateSpec((prev) => ({
                        ...prev,
                        overlayOpacity: parseFloat(e.target.value),
                      }))
                    }
                  />
                </div>
              </div>

              {/* Layout e Área Útil */}
              <div className="layout-fields-section">
                <h4>Layout e Margens de Segurança</h4>

                <div className="slider-field">
                  <div className="slider-label-row">
                    <label htmlFor={`${idPrefix}-create-safe-area`}>
                      Área de segurança (safeArea)
                    </label>
                    <span>{createSpec.safeArea} px</span>
                  </div>
                  <input
                    id={`${idPrefix}-create-safe-area`}
                    type="range"
                    min={40}
                    max={240}
                    step={10}
                    value={createSpec.safeArea}
                    onChange={(e) =>
                      setCreateSpec((prev) => ({
                        ...prev,
                        safeArea: parseInt(e.target.value, 10),
                      }))
                    }
                  />
                  {createSpec.safeArea > 160 && (
                    <p className="warning-hint">
                      Atenção: Margens superiores a 160px reduzem a área útil
                      para textos em formatos móveis.
                    </p>
                  )}
                </div>

                <div className="form-row-2">
                  <div className="form-group">
                    <label htmlFor={`${idPrefix}-create-align`}>
                      Alinhamento do texto
                    </label>
                    <select
                      id={`${idPrefix}-create-align`}
                      value={createSpec.textAlign}
                      onChange={(e) =>
                        setCreateSpec((prev) => ({
                          ...prev,
                          textAlign: e.target.value as
                            "left" | "center" | "right",
                        }))
                      }
                    >
                      <option value="left">Alinhado à esquerda</option>
                      <option value="center">Centralizado</option>
                      <option value="right">Alinhado à direita</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label htmlFor={`${idPrefix}-create-max-lines`}>
                      Limite de linhas do título
                    </label>
                    <select
                      id={`${idPrefix}-create-max-lines`}
                      value={createSpec.titleMaxLines}
                      onChange={(e) =>
                        setCreateSpec((prev) => ({
                          ...prev,
                          titleMaxLines: parseInt(e.target.value, 10),
                        }))
                      }
                    >
                      <option value={1}>1 linha (Títulos muito curtos)</option>
                      <option value={2}>2 linhas</option>
                      <option value={3}>3 linhas (Recomendado)</option>
                      <option value={4}>4 linhas (Títulos longos)</option>
                    </select>
                  </div>
                </div>

                {/* Elementos Visíveis */}
                <div className="checkbox-toggles-group">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={createSpec.showEyebrow}
                      onChange={(e) =>
                        setCreateSpec((prev) => ({
                          ...prev,
                          showEyebrow: e.target.checked,
                        }))
                      }
                    />
                    Exibir chamada superior (eyebrow)
                  </label>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={createSpec.showSubtitle}
                      onChange={(e) =>
                        setCreateSpec((prev) => ({
                          ...prev,
                          showSubtitle: e.target.checked,
                        }))
                      }
                    />
                    Exibir texto complementar (subtítulo)
                  </label>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={createSpec.showCallToAction}
                      onChange={(e) =>
                        setCreateSpec((prev) => ({
                          ...prev,
                          showCallToAction: e.target.checked,
                        }))
                      }
                    />
                    Exibir chamada para ação (botão CTA)
                  </label>
                </div>
              </div>

              <div className="form-actions">
                <button type="submit" disabled={creating}>
                  {creating ? "Criando…" : "Criar modelo (Versão 1)"}
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={handleBackToList}
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>

          {/* Coluna Direita: Prévia Compartilhada e Avaliação de Contraste */}
          <div className="editor-preview-column">
            <div className="preview-toolbar">
              <label className="preview-toggle-guide">
                <input
                  type="checkbox"
                  checked={showSafeAreaGuides}
                  onChange={(e) => setShowSafeAreaGuides(e.target.checked)}
                />
                Guias de área segura
              </label>

              <div className="simulation-selector">
                <span className="small muted">Simular texto:</span>
                <select
                  value={simulationLength}
                  onChange={(e) =>
                    setSimulationLength(
                      e.target.value as "short" | "medium" | "limit",
                    )
                  }
                  className="small-select"
                >
                  <option value="short">Texto curto</option>
                  <option value="medium">Texto médio</option>
                  <option value="limit">No limite (180 chars)</option>
                </select>
              </div>
            </div>

            <ArtworkPreview
              spec={createSpec}
              format={createSpec.format}
              title={simText.title}
              eyebrow={simText.eyebrow}
              subtitle={simText.subtitle}
              callToAction={simText.cta}
              showSafeAreaGuides={showSafeAreaGuides}
            />

            {/* Painel de Avaliação de Contraste WCAG 2.1 */}
            <div className="contrast-report-card">
              <h4>Análise de Contraste WCAG 2.1</h4>
              <p className="small muted">
                Fundo efetivo com composição alfa:{" "}
                <code>{contrastAnalysis.effectiveBackgroundHex}</code>
              </p>

              <div className="contrast-metrics-list">
                {contrastAnalysis.elements.map((elem) => (
                  <div key={elem.element} className="contrast-metric-item">
                    <div className="contrast-metric-header">
                      <strong>{elem.label}</strong>
                      <span
                        className={`contrast-badge status-${elem.status.toLowerCase()}`}
                      >
                        {elem.statusLabel} ({elem.formattedRatio})
                      </span>
                    </div>
                    <p className="contrast-explanation small">
                      {elem.explanation}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* Painel de Orçamento Vertical e Safe Area */}
            <LayoutBudgetCard layoutBudget={layoutBudget} />
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* VISÃO 3: DETALHES DO TEMPLATE E HISTÓRICO DE VERSÕES                     */}
      {/* ========================================================================= */}
      {viewMode === "detail" && loadingDetail && !detail && (
        <p className="empty" role="status">
          Carregando detalhes do modelo…
        </p>
      )}

      {viewMode === "detail" && detail && (
        <div className="template-detail-view">
          {/* Cabeçalho do Template */}
          <div className="template-detail-header">
            <div>
              <div className="template-title-row">
                <h3>{detail.name}</h3>
                {detail.systemKey && (
                  <span className="system-badge">Modelo inicial</span>
                )}
                <span
                  className={`badge ${detail.status === "ACTIVE" ? "badge-active" : "badge-archived"}`}
                >
                  {detail.status === "ACTIVE" ? "Ativo" : "Arquivado"}
                </span>
              </div>
              <p className="muted small">
                Criado em {formatDate(detail.createdAt)} · Última atualização em{" "}
                {formatDate(detail.updatedAt)}
              </p>
            </div>

            <div className="detail-header-actions">
              {canEditTemplates &&
                detail.status === "ACTIVE" &&
                !isEditingVersion && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditingVersion(true);
                      setPreviewVersionIndex(null);
                      if (latestDetailVersion) {
                        setBaseVersionNumber(latestDetailVersion.version);
                        setBaseSpec(
                          JSON.parse(JSON.stringify(latestDetailVersion.spec)),
                        );
                        setEditSpec(
                          JSON.parse(JSON.stringify(latestDetailVersion.spec)),
                        );
                        setConflictState(null);
                      }
                    }}
                  >
                    Criar nova versão
                  </button>
                )}

              {canEditTemplates && (
                <button
                  type="button"
                  className="quiet"
                  onClick={() => {
                    setDuplicatingTemplate({
                      id: detail.id,
                      name: detail.name,
                      status: detail.status,
                      systemKey: detail.systemKey,
                      createdAt: detail.createdAt,
                      updatedAt: detail.updatedAt,
                      latestVersion: latestDetailVersion,
                    });
                    setDuplicateName(`${detail.name} (Cópia)`);
                  }}
                >
                  Duplicar
                </button>
              )}

              {canEditTemplates && (
                <button
                  type="button"
                  className="quiet"
                  onClick={() => {
                    setRenamingTemplate({
                      id: detail.id,
                      name: detail.name,
                      status: detail.status,
                      systemKey: detail.systemKey,
                      createdAt: detail.createdAt,
                      updatedAt: detail.updatedAt,
                      latestVersion: latestDetailVersion,
                    });
                    setRenameValue(detail.name);
                  }}
                >
                  Renomear
                </button>
              )}

              {canEditTemplates && detail.status === "ACTIVE" && (
                <button
                  type="button"
                  className="quiet danger"
                  onClick={() =>
                    setArchivingTemplate({
                      id: detail.id,
                      name: detail.name,
                      status: detail.status,
                      systemKey: detail.systemKey,
                      createdAt: detail.createdAt,
                      updatedAt: detail.updatedAt,
                      latestVersion: latestDetailVersion,
                    })
                  }
                >
                  Arquivar
                </button>
              )}

              {canReactivateTemplates && detail.status === "ARCHIVED" && (
                <button
                  type="button"
                  className="quiet"
                  onClick={() => handleReactivate(detail.id, detail.name)}
                >
                  Reativar modelo
                </button>
              )}
            </div>
          </div>

          <div className="template-editor-layout">
            {/* Coluna Esquerda: Edição de Versão ou Visualização da Versão Ativa */}
            <div className="editor-form-column">
              {conflictState && conflictState.hasConflict && (
                <div
                  className="conflict-alert-card"
                  role="alert"
                  data-testid="concurrency-conflict-banner"
                >
                  <div className="conflict-header">
                    <span className="conflict-icon" aria-hidden="true">
                      ⚠️
                    </span>
                    <div>
                      <h4>Conflito de concorrência detectado</h4>
                      <p>
                        Outro usuário publicou uma nova versão enquanto você
                        editava.
                        <strong>
                          {" "}
                          Nenhuma alteração foi salva no servidor. Seu rascunho
                          de trabalho foi preservado intacto.
                        </strong>
                      </p>
                    </div>
                  </div>

                  {conflictState.fetchError ? (
                    <div
                      className="conflict-fetch-error-box"
                      data-testid="conflict-fetch-error-box"
                      style={{
                        margin: "12px 0",
                        padding: "10px 14px",
                        background: "rgba(239, 68, 68, 0.1)",
                        border: "1px solid rgba(239, 68, 68, 0.3)",
                        borderRadius: 6,
                      }}
                    >
                      <p
                        style={{
                          color: "#ef4444",
                          margin: 0,
                          fontSize: "13px",
                        }}
                      >
                        <strong>Aviso:</strong> O conflito foi detectado, mas
                        não foi possível carregar a versão atual do servidor (
                        {conflictState.fetchError}).
                      </p>
                      <button
                        type="button"
                        className="quiet"
                        style={{ marginTop: 8 }}
                        data-testid="retry-load-conflict-btn"
                        onClick={() => {
                          if (detail) {
                            void reloadConflictServerVersion(
                              detail.id,
                              conflictState.baseVersionNumber,
                            );
                          }
                        }}
                      >
                        🔄 Tentar carregar versão atual novamente
                      </button>
                    </div>
                  ) : conflictState.isLoadingServerVersion ? (
                    <div
                      className="conflict-loading-box"
                      style={{ margin: "12px 0" }}
                    >
                      <p className="small muted">
                        Carregando versão mais recente do servidor para
                        comparação…
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="conflict-meta-box">
                        <div>
                          <strong>Versão em que sua edição começou:</strong> v
                          {conflictState.baseVersionNumber}
                        </div>
                        <div>
                          <strong>
                            Versão atual mais recente no servidor:
                          </strong>{" "}
                          v{conflictState.serverVersion}
                        </div>
                      </div>

                      {conflictState.diffItems.length > 0 && (
                        <div className="conflict-diff-box">
                          <h5>
                            Diferenças entre a nova versão-base (v
                            {conflictState.serverVersion}) e seu rascunho
                            preservado:
                          </h5>
                          <ul className="diff-list">
                            {conflictState.diffItems.map((item, idx) => (
                              <li key={idx}>
                                <strong>{item.label}:</strong>{" "}
                                {item.beforeDescription} ➔{" "}
                                <em>{item.afterDescription}</em>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="conflict-actions">
                        <button
                          type="button"
                          className="primary-btn"
                          data-testid="reapply-draft-btn"
                          disabled={!canReapplyConflict(conflictState)}
                          onClick={handleReapplyOverServerVersion}
                        >
                          Reaplicar sobre a versão atual (v
                          {conflictState.serverVersion})
                        </button>
                        <button
                          type="button"
                          className="quiet danger"
                          data-testid="discard-draft-btn"
                          disabled={!canDiscardConflict(conflictState)}
                          onClick={handleDiscardDraft}
                        >
                          Descartar meu rascunho
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {isEditingVersion ? (
                <form onSubmit={handleSubmitVersion} className="template-form">
                  <div className="editor-form-header">
                    <h4>Editando nova versão para "{detail.name}"</h4>
                    <p className="muted small">
                      A versão atual (v{latestDetailVersion?.version})
                      permanecerá imutável. Uma nova versão sequencial será
                      gerada.
                    </p>
                  </div>

                  {/* Indicador de Alteração Não Salva */}
                  {isVersionDirty && (
                    <div className="unsaved-badge" role="status">
                      ● Alterações não salvas na especificação
                    </div>
                  )}

                  {/* Controles de Cores */}
                  <div className="colors-grid-section">
                    <h4>Paleta de Cores</h4>
                    <div className="color-fields-grid">
                      <div className="color-field">
                        <label htmlFor={`${idPrefix}-edit-bg`}>Fundo</label>
                        <div className="color-input-wrapper">
                          <input
                            type="color"
                            id={`${idPrefix}-edit-bg`}
                            value={editSpec.backgroundColor}
                            onChange={(e) =>
                              setEditSpec((prev) => ({
                                ...prev,
                                backgroundColor: e.target.value.toUpperCase(),
                              }))
                            }
                          />
                          <code>{editSpec.backgroundColor}</code>
                        </div>
                      </div>

                      <div className="color-field">
                        <label htmlFor={`${idPrefix}-edit-overlay`}>
                          Sobreposição
                        </label>
                        <div className="color-input-wrapper">
                          <input
                            type="color"
                            id={`${idPrefix}-edit-overlay`}
                            value={editSpec.overlayColor}
                            onChange={(e) =>
                              setEditSpec((prev) => ({
                                ...prev,
                                overlayColor: e.target.value.toUpperCase(),
                              }))
                            }
                          />
                          <code>{editSpec.overlayColor}</code>
                        </div>
                      </div>

                      <div className="color-field">
                        <label htmlFor={`${idPrefix}-edit-text`}>
                          Texto Principal
                        </label>
                        <div className="color-input-wrapper">
                          <input
                            type="color"
                            id={`${idPrefix}-edit-text`}
                            value={editSpec.textColor}
                            onChange={(e) =>
                              setEditSpec((prev) => ({
                                ...prev,
                                textColor: e.target.value.toUpperCase(),
                              }))
                            }
                          />
                          <code>{editSpec.textColor}</code>
                        </div>
                      </div>

                      <div className="color-field">
                        <label htmlFor={`${idPrefix}-edit-muted`}>
                          Texto Secundário
                        </label>
                        <div className="color-input-wrapper">
                          <input
                            type="color"
                            id={`${idPrefix}-edit-muted`}
                            value={editSpec.mutedTextColor}
                            onChange={(e) =>
                              setEditSpec((prev) => ({
                                ...prev,
                                mutedTextColor: e.target.value.toUpperCase(),
                              }))
                            }
                          />
                          <code>{editSpec.mutedTextColor}</code>
                        </div>
                      </div>

                      <div className="color-field">
                        <label htmlFor={`${idPrefix}-edit-accent`}>
                          Destaque / CTA
                        </label>
                        <div className="color-input-wrapper">
                          <input
                            type="color"
                            id={`${idPrefix}-edit-accent`}
                            value={editSpec.accentColor}
                            onChange={(e) =>
                              setEditSpec((prev) => ({
                                ...prev,
                                accentColor: e.target.value.toUpperCase(),
                              }))
                            }
                          />
                          <code>{editSpec.accentColor}</code>
                        </div>
                      </div>
                    </div>

                    <div className="slider-field">
                      <div className="slider-label-row">
                        <label htmlFor={`${idPrefix}-edit-opacity`}>
                          Opacidade da sobreposição
                        </label>
                        <span>
                          {Math.round(editSpec.overlayOpacity * 100)}%
                        </span>
                      </div>
                      <input
                        id={`${idPrefix}-edit-opacity`}
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={editSpec.overlayOpacity}
                        onChange={(e) =>
                          setEditSpec((prev) => ({
                            ...prev,
                            overlayOpacity: parseFloat(e.target.value),
                          }))
                        }
                      />
                    </div>
                  </div>

                  {/* Margens e Tipografia */}
                  <div className="layout-fields-section">
                    <h4>Safe Area e Tipografia</h4>
                    <div className="slider-field">
                      <div className="slider-label-row">
                        <label htmlFor={`${idPrefix}-edit-safe-area`}>
                          Área de segurança (safeArea)
                        </label>
                        <span>{editSpec.safeArea} px</span>
                      </div>
                      <input
                        id={`${idPrefix}-edit-safe-area`}
                        type="range"
                        min={40}
                        max={240}
                        step={10}
                        value={editSpec.safeArea}
                        onChange={(e) =>
                          setEditSpec((prev) => ({
                            ...prev,
                            safeArea: parseInt(e.target.value, 10),
                          }))
                        }
                      />
                    </div>

                    <div className="form-row-2">
                      <div className="form-group">
                        <label htmlFor={`${idPrefix}-edit-align`}>
                          Alinhamento
                        </label>
                        <select
                          id={`${idPrefix}-edit-align`}
                          value={editSpec.textAlign}
                          onChange={(e) =>
                            setEditSpec((prev) => ({
                              ...prev,
                              textAlign: e.target.value as
                                "left" | "center" | "right",
                            }))
                          }
                        >
                          <option value="left">Esquerda</option>
                          <option value="center">Centralizado</option>
                          <option value="right">Direita</option>
                        </select>
                      </div>

                      <div className="form-group">
                        <label htmlFor={`${idPrefix}-edit-max-lines`}>
                          Linhas do título
                        </label>
                        <select
                          id={`${idPrefix}-edit-max-lines`}
                          value={editSpec.titleMaxLines}
                          onChange={(e) =>
                            setEditSpec((prev) => ({
                              ...prev,
                              titleMaxLines: parseInt(e.target.value, 10),
                            }))
                          }
                        >
                          <option value={1}>1 linha</option>
                          <option value={2}>2 linhas</option>
                          <option value={3}>3 linhas</option>
                          <option value={4}>4 linhas</option>
                        </select>
                      </div>
                    </div>

                    <div className="checkbox-toggles-group">
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={editSpec.showEyebrow}
                          onChange={(e) =>
                            setEditSpec((prev) => ({
                              ...prev,
                              showEyebrow: e.target.checked,
                            }))
                          }
                        />
                        Exibir chamada superior
                      </label>

                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={editSpec.showSubtitle}
                          onChange={(e) =>
                            setEditSpec((prev) => ({
                              ...prev,
                              showSubtitle: e.target.checked,
                            }))
                          }
                        />
                        Exibir texto complementar
                      </label>

                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={editSpec.showCallToAction}
                          onChange={(e) =>
                            setEditSpec((prev) => ({
                              ...prev,
                              showCallToAction: e.target.checked,
                            }))
                          }
                        />
                        Exibir chamada para ação
                      </label>
                    </div>
                  </div>

                  {/* Resumo Legível de Alterações em Relação à Versão-Base */}
                  {pendingChanges.length > 0 && (
                    <div
                      className="diff-summary-card"
                      data-testid="diff-summary-card"
                    >
                      <h5>Resumo de alterações (vs v{baseVersionNumber}):</h5>
                      <ul className="diff-list">
                        {pendingChanges.map((diff, idx) => (
                          <li key={idx}>
                            <strong>{diff.label}:</strong>{" "}
                            {diff.beforeDescription} ➔ {diff.afterDescription}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="form-actions">
                    <button
                      type="submit"
                      disabled={
                        savingVersion ||
                        !isVersionDirty ||
                        (conflictState?.hasConflict &&
                          (conflictState.serverVersion === null ||
                            Boolean(conflictState.fetchError)))
                      }
                    >
                      {savingVersion ? "Salvando…" : "Salvar nova versão"}
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => {
                        if (confirmDiscardChanges()) {
                          setIsEditingVersion(false);
                          setConflictState(null);
                          if (latestDetailVersion) {
                            setBaseVersionNumber(latestDetailVersion.version);
                            setBaseSpec(
                              JSON.parse(
                                JSON.stringify(latestDetailVersion.spec),
                              ),
                            );
                            setEditSpec(
                              JSON.parse(
                                JSON.stringify(latestDetailVersion.spec),
                              ),
                            );
                          }
                        }
                      }}
                    >
                      Cancelar edição
                    </button>
                  </div>
                </form>
              ) : (
                <div className="version-info-box">
                  <div className="version-active-card">
                    <h4>
                      {previewVersionIndex !== null
                        ? `Visualizando Versão ${detail.versions[previewVersionIndex]?.version} (Histórica)`
                        : `Versão Ativa: v${latestDetailVersion?.version}`}
                    </h4>
                    <p className="small muted">
                      {previewVersionIndex !== null
                        ? "Esta é uma visualização em modo de leitura. Não afeta a versão mais recente em uso no gerador."
                        : "Esta versão é atualmente selecionada para as novas gerações de arte."}
                    </p>

                    <dl className="spec-meta-list">
                      <dt>Formato:</dt>
                      <dd>
                        {FORMAT_DETAILS[activeFormatForPreview]?.label} (
                        {FORMAT_DETAILS[activeFormatForPreview]?.dimensions})
                      </dd>
                      <dt>Fonte padrão:</dt>
                      <dd>Inter (Empacotada)</dd>
                      <dt>Versão do Renderer:</dt>
                      <dd>
                        <code>
                          {latestDetailVersion?.rendererVersion ??
                            "satori-sharp"}
                        </code>
                      </dd>
                      <dt>Hash do Spec:</dt>
                      <dd>
                        <code>
                          {latestDetailVersion?.specHash?.slice(0, 16)}…
                        </code>
                      </dd>
                    </dl>

                    {/* Comparação Legível de Versão Histórica com a Mais Recente */}
                    {previewVersionIndex !== null &&
                      detail.versions[previewVersionIndex] &&
                      latestDetailVersion && (
                        <div
                          className="diff-summary-card"
                          data-testid="history-diff-card"
                          style={{ marginTop: 14 }}
                        >
                          <h5>
                            Diferenças em relação à versão ativa mais recente (v
                            {latestDetailVersion.version}):
                          </h5>
                          {describeTemplateDifferences(
                            detail.versions[previewVersionIndex].spec,
                            latestDetailVersion.spec,
                          ).length === 0 ? (
                            <p className="small muted">
                              Especificações idênticas à versão mais recente.
                            </p>
                          ) : (
                            <ul className="diff-list">
                              {describeTemplateDifferences(
                                detail.versions[previewVersionIndex].spec,
                                latestDetailVersion.spec,
                              ).map((diff, idx) => (
                                <li key={idx}>
                                  <strong>{diff.label}:</strong>{" "}
                                  {diff.beforeDescription} ➔{" "}
                                  {diff.afterDescription}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                  </div>
                </div>
              )}

              {/* Tabela de Histórico de Versões */}
              <div className="versions-history-section">
                <h4>Histórico de Versões</h4>
                <p className="small muted">
                  Todas as versões criadas são imutáveis e auditadas.
                </p>

                <div className="versions-timeline">
                  {detail.versions
                    .map((v, idx) => ({ versionObj: v, originalIndex: idx }))
                    .sort((a, b) => b.versionObj.version - a.versionObj.version)
                    .map(({ versionObj, originalIndex }) => {
                      const isSelectedPreview =
                        previewVersionIndex === originalIndex;
                      const isLatest =
                        versionObj.version === latestDetailVersion?.version;

                      return (
                        <div
                          key={versionObj.id}
                          className={`timeline-version-row ${isSelectedPreview ? "active-preview" : ""}`}
                        >
                          <div className="version-col-info">
                            <strong>
                              Versão {versionObj.version}
                              {isLatest && " (Mais recente)"}
                            </strong>
                            <span className="small muted">
                              Criada em {formatDate(versionObj.createdAt)} ·{" "}
                              <code>{versionObj.specHash.slice(0, 8)}…</code>
                            </span>
                          </div>

                          <div className="version-col-actions">
                            <button
                              type="button"
                              className="quiet small-btn"
                              onClick={() => {
                                setIsEditingVersion(false);
                                setPreviewVersionIndex(originalIndex);
                              }}
                            >
                              {isSelectedPreview
                                ? "Visualizando"
                                : "Visualizar esta versão"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>

            {/* Coluna Direita: Prévia e Contraste */}
            <div className="editor-preview-column">
              <div className="preview-toolbar">
                <label className="preview-toggle-guide">
                  <input
                    type="checkbox"
                    checked={showSafeAreaGuides}
                    onChange={(e) => setShowSafeAreaGuides(e.target.checked)}
                  />
                  Guias de safe area
                </label>

                <div className="simulation-selector">
                  <span className="small muted">Texto:</span>
                  <select
                    value={simulationLength}
                    onChange={(e) =>
                      setSimulationLength(
                        e.target.value as "short" | "medium" | "limit",
                      )
                    }
                    className="small-select"
                  >
                    <option value="short">Curto</option>
                    <option value="medium">Médio</option>
                    <option value="limit">No limite (180 chars)</option>
                  </select>
                </div>
              </div>

              <ArtworkPreview
                spec={activeSpecForPreview}
                format={activeFormatForPreview}
                title={simText.title}
                eyebrow={simText.eyebrow}
                subtitle={simText.subtitle}
                callToAction={simText.cta}
                showSafeAreaGuides={showSafeAreaGuides}
              />

              {/* Análise de Contraste */}
              <div className="contrast-report-card">
                <h4>Análise de Contraste WCAG 2.1</h4>
                <p className="small muted">
                  Fundo efetivo:{" "}
                  <code>{contrastAnalysis.effectiveBackgroundHex}</code>
                </p>

                <div className="contrast-metrics-list">
                  {contrastAnalysis.elements.map((elem) => (
                    <div key={elem.element} className="contrast-metric-item">
                      <div className="contrast-metric-header">
                        <strong>{elem.label}</strong>
                        <span
                          className={`contrast-badge status-${elem.status.toLowerCase()}`}
                        >
                          {elem.statusLabel} ({elem.formattedRatio})
                        </span>
                      </div>
                      <p className="contrast-explanation small">
                        {elem.explanation}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Painel de Orçamento Vertical e Safe Area */}
              <LayoutBudgetCard layoutBudget={layoutBudget} />
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 1: DUPLICAR TEMPLATE                                                */}
      {/* ========================================================================= */}
      {duplicatingTemplate && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="publish-modal">
            <h3>Duplicar modelo de design</h3>
            <p className="muted">
              Uma cópia independente será gerada a partir da versão mais recente
              de <strong>"{duplicatingTemplate.name}"</strong>. O novo modelo
              iniciará na versão 1 como ativo e desvinculado do sistema.
            </p>

            <form onSubmit={handleConfirmDuplicate}>
              <div className="form-group">
                <label htmlFor={`${idPrefix}-duplicate-name`}>
                  Nome do novo modelo *
                </label>
                <input
                  id={`${idPrefix}-duplicate-name`}
                  type="text"
                  required
                  minLength={2}
                  maxLength={120}
                  value={duplicateName}
                  onChange={(e) => setDuplicateName(e.target.value)}
                />
              </div>

              <div className="form-actions">
                <button type="submit" disabled={duplicating}>
                  {duplicating ? "Duplicando…" : "Confirmar duplicação"}
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => setDuplicatingTemplate(null)}
                  disabled={duplicating}
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 2: RENOMEAR TEMPLATE                                                */}
      {/* ========================================================================= */}
      {renamingTemplate && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="publish-modal">
            <h3>Renomear modelo</h3>
            <p className="muted">
              A alteração de nome preserva a identidade e todas as versões já
              existentes sem gerar incremento de versão.
            </p>

            <form onSubmit={handleConfirmRename}>
              <div className="form-group">
                <label htmlFor={`${idPrefix}-rename-val`}>Novo nome *</label>
                <input
                  id={`${idPrefix}-rename-val`}
                  type="text"
                  required
                  minLength={2}
                  maxLength={120}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                />
              </div>

              <div className="form-actions">
                <button type="submit" disabled={renaming}>
                  {renaming ? "Salvando…" : "Salvar novo nome"}
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => setRenamingTemplate(null)}
                  disabled={renaming}
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 3: ARQUIVAR TEMPLATE                                                */}
      {/* ========================================================================= */}
      {archivingTemplate && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="publish-modal">
            <h3>Arquivar modelo</h3>
            <p>
              Tem certeza que deseja arquivar o modelo{" "}
              <strong>"{archivingTemplate.name}"</strong>?
            </p>
            <p className="muted small">
              Modelos arquivados não poderão mais ser selecionados para novas
              gerações de arte no Gerador de Artes. Todo o histórico de
              renderizações anteriores será integralmente preservado.
            </p>

            <div className="form-actions">
              <button
                type="button"
                className="danger"
                onClick={handleConfirmArchive}
                disabled={archiving}
              >
                {archiving ? "Arquivando…" : "Sim, arquivar modelo"}
              </button>
              <button
                type="button"
                className="quiet"
                onClick={() => setArchivingTemplate(null)}
                disabled={archiving}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 4: CONFIRMAÇÃO EXPLÍCITA DE CONTRASTE REPROVADO                    */}
      {/* ========================================================================= */}
      {contrastConfirmDialog && contrastConfirmDialog.isOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          data-testid="contrast-confirm-modal"
        >
          <div className="publish-modal">
            <div className="modal-header-warning">
              <span className="warning-icon" aria-hidden="true">
                ⚠️
              </span>
              <h3>Confirmação de Contraste Reprovado</h3>
            </div>
            <p>
              A paleta de cores configurada possui elementos que{" "}
              <strong>
                não atendem aos critérios mínimos de contraste da WCAG 2.1
              </strong>
              :
            </p>
            {contrastConfirmDialog.isEstimated && (
              <p className="notice small">
                Aviso: Com imagem de fundo ativa, a análise de contraste é
                estimada sobre o fundo médio calculado.
              </p>
            )}
            <div className="contrast-failure-list">
              {contrastConfirmDialog.failedElements.map((elem, i) => (
                <div key={i} className="contrast-failure-item">
                  <strong>{elem.label}:</strong> {elem.statusLabel} (
                  {elem.ratio})<p className="small muted">{elem.explanation}</p>
                </div>
              ))}
            </div>
            <p className="muted small">
              Salvar combinações com baixo contraste pode prejudicar a
              legibilidade dos textos em redes sociais. Deseja prosseguir e
              salvar mesmo assim?
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="warning-btn"
                data-testid="confirm-contrast-save-btn"
                onClick={contrastConfirmDialog.onConfirm}
              >
                Confirmar e Salvar Mesmo Assim
              </button>
              <button
                type="button"
                className="quiet"
                data-testid="cancel-contrast-save-btn"
                onClick={() => setContrastConfirmDialog(null)}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
