import type { DesignTemplateSpec } from "@socialflow/contracts";

export interface TemplateDifferenceItem {
  property: keyof DesignTemplateSpec;
  label: string;
  before: string;
  after: string;
  beforeDescription: string;
  afterDescription: string;
}

export interface ConflictState {
  hasConflict: true;
  baseVersionNumber: number;
  serverVersion: number | null;
  serverSpec: DesignTemplateSpec | null;
  diffItems: TemplateDifferenceItem[];
  fetchError: string | null;
  isLoadingServerVersion: boolean;
}

export interface ContextIdentity {
  org: string;
  clientId: string;
  templateId: string | null;
  requestId: number;
}

export type DiffCalculator = (
  serverSpec: DesignTemplateSpec,
  draftSpec: DesignTemplateSpec,
) => TemplateDifferenceItem[];

export function computeTemplateDifferences(
  serverSpec: DesignTemplateSpec,
  draftSpec: DesignTemplateSpec,
): TemplateDifferenceItem[] {
  const diffs: TemplateDifferenceItem[] = [];
  const keys = Array.from(
    new Set([...Object.keys(serverSpec), ...Object.keys(draftSpec)]),
  ) as (keyof DesignTemplateSpec)[];

  for (const key of keys) {
    if (JSON.stringify(serverSpec[key]) !== JSON.stringify(draftSpec[key])) {
      diffs.push({
        property: key,
        label: String(key),
        before: String(serverSpec[key] ?? ""),
        after: String(draftSpec[key] ?? ""),
        beforeDescription: String(serverSpec[key] ?? ""),
        afterDescription: String(draftSpec[key] ?? ""),
      });
    }
  }
  return diffs;
}

/**
 * Cria o estado inicial de conflito quando o servidor responde com HTTP 409.
 * Preserva o rascunho atual e a versão-base de partida.
 */
export function createInitialConflictState(
  baseVersionNumber: number,
  isLoading = true,
): ConflictState {
  return {
    hasConflict: true,
    baseVersionNumber,
    serverVersion: null,
    serverSpec: null,
    diffItems: [],
    fetchError: null,
    isLoadingServerVersion: isLoading,
  };
}

/**
 * Atualiza o estado de conflito após consulta bem-sucedida da versão mais recente do servidor.
 * Mantém o rascunho de edição (draftSpec) intocado e gera a lista legível de diferenças.
 */
export function applyConflictFetchSuccess(
  state: ConflictState,
  serverVersion: number,
  serverSpec: DesignTemplateSpec,
  draftSpec: DesignTemplateSpec,
  diffCalculator?: DiffCalculator,
): ConflictState {
  const diffItems = diffCalculator
    ? diffCalculator(serverSpec, draftSpec)
    : computeTemplateDifferences(serverSpec, draftSpec);
  return {
    ...state,
    serverVersion,
    serverSpec,
    diffItems,
    fetchError: null,
    isLoadingServerVersion: false,
  };
}

/**
 * Atualiza o estado de conflito quando a consulta da versão remota falha (ex: queda de rede, 500).
 * NUNCA engole a falha e preserva o rascunho e a versão-base inicial.
 */
export function applyConflictFetchFailure(
  state: ConflictState,
  errorMsg: string,
): ConflictState {
  return {
    ...state,
    fetchError:
      errorMsg ||
      "O conflito foi detectado, mas não foi possível carregar a versão atual do servidor.",
    isLoadingServerVersion: false,
  };
}

/**
 * Reaplicar só é permitido após a versão atual do servidor ter sido carregada com sucesso.
 */
export function canReapplyConflict(state: ConflictState | null): boolean {
  if (!state || !state.hasConflict) return false;
  if (state.isLoadingServerVersion) return false;
  if (state.serverVersion === null || state.serverSpec === null) return false;
  if (state.fetchError !== null) return false;
  return true;
}

/**
 * Descartar só é permitido após a versão atual do servidor ter sido carregada com sucesso.
 */
export function canDiscardConflict(state: ConflictState | null): boolean {
  if (!state || !state.hasConflict) return false;
  if (state.isLoadingServerVersion) return false;
  if (state.serverVersion === null || state.serverSpec === null) return false;
  return true;
}

/**
 * Validação de permissão de submissão do formulário de versão.
 * Bloqueia nova submissão enquanto houver conflito pendente ou se a versão do servidor não foi carregada.
 */
export function validateVersionSubmission(params: {
  isEditingVersion: boolean;
  isVersionDirty: boolean;
  conflictState: ConflictState | null;
}): { allowed: boolean; reason?: string } {
  const { isEditingVersion, isVersionDirty, conflictState } = params;

  if (!isEditingVersion) {
    return { allowed: false, reason: "Modo de edição inativo." };
  }

  if (conflictState && conflictState.hasConflict) {
    if (conflictState.isLoadingServerVersion) {
      return {
        allowed: false,
        reason:
          "Aguarde o carregamento da versão atual do servidor antes de salvar.",
      };
    }
    if (conflictState.serverVersion === null || conflictState.fetchError) {
      return {
        allowed: false,
        reason:
          "Não é possível salvar enquanto a versão atual do servidor não for carregada. Tente carregar novamente.",
      };
    }
    return {
      allowed: false,
      reason:
        "Existe um conflito de versão pendente. Reaplique seu rascunho ou descarte antes de salvar.",
    };
  }

  if (!isVersionDirty) {
    return {
      allowed: false,
      reason: "Nenhuma alteração detectada em relação à versão atual.",
    };
  }

  return { allowed: true };
}

/**
 * Verifica se uma resposta atrasada ainda corresponde à identidade exata do contexto ativo.
 */
export function isContextMatching(
  active: {
    org: string;
    clientId: string;
    templateId: string | null;
    requestId: number;
  },
  incoming: {
    org: string;
    clientId: string;
    templateId: string;
    requestId: number;
  },
): boolean {
  return (
    active.org === incoming.org &&
    active.clientId === incoming.clientId &&
    active.templateId === incoming.templateId &&
    active.requestId === incoming.requestId
  );
}

/**
 * Gerenciador de Ciclo de Vida e Requisições de Detalhe e Conflito.
 * Implementa controle de AbortController, contadores de geração e proteção contra respostas obsoletas.
 */
export class TemplateDetailLifecycleController {
  private activeOrg: string;
  private activeClientId: string;
  private activeTemplateId: string | null = null;
  private detailRequestId = 0;
  private conflictRequestId = 0;

  private detailAbortController: AbortController | null = null;
  private conflictAbortController: AbortController | null = null;

  constructor(org: string, clientId: string) {
    this.activeOrg = org;
    this.activeClientId = clientId;
  }

  public updateContext(
    org: string,
    clientId: string,
    templateId: string | null,
  ): void {
    const clientChanged =
      this.activeOrg !== org || this.activeClientId !== clientId;
    const templateChanged = this.activeTemplateId !== templateId;

    this.activeOrg = org;
    this.activeClientId = clientId;
    this.activeTemplateId = templateId;

    if (clientChanged || templateChanged) {
      this.abortAll("Context switched");
    }
  }

  public getActiveContext() {
    return {
      org: this.activeOrg,
      clientId: this.activeClientId,
      templateId: this.activeTemplateId,
    };
  }

  public startDetailRequest(targetTemplateId: string): {
    signal: AbortSignal;
    requestId: number;
    isCurrent: (reqId: number) => boolean;
  } {
    this.detailAbortController?.abort("Starting new detail request");
    this.conflictAbortController?.abort("Starting new detail request");
    const controller = new AbortController();
    this.detailAbortController = controller;

    const reqId = ++this.detailRequestId;
    this.activeTemplateId = targetTemplateId;

    return {
      signal: controller.signal,
      requestId: reqId,
      isCurrent: (id: number) =>
        this.activeTemplateId === targetTemplateId &&
        this.detailRequestId === id &&
        !controller.signal.aborted,
    };
  }

  public startConflictRequest(targetTemplateId: string): {
    signal: AbortSignal;
    requestId: number;
    isCurrent: (reqId: number) => boolean;
  } {
    this.conflictAbortController?.abort("Starting new conflict request");
    const controller = new AbortController();
    this.conflictAbortController = controller;

    const reqId = ++this.conflictRequestId;
    this.activeTemplateId = targetTemplateId;

    return {
      signal: controller.signal,
      requestId: reqId,
      isCurrent: (id: number) =>
        this.activeTemplateId === targetTemplateId &&
        this.conflictRequestId === id &&
        !controller.signal.aborted,
    };
  }

  public abortAll(reason = "Aborted"): void {
    if (this.detailAbortController) {
      this.detailAbortController.abort(reason);
      this.detailAbortController = null;
    }
    if (this.conflictAbortController) {
      this.conflictAbortController.abort(reason);
      this.conflictAbortController = null;
    }
  }
}
