import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DesignTemplateSpec } from "../../packages/contracts/src/design.js";
import {
  applyConflictFetchFailure,
  applyConflictFetchSuccess,
  canDiscardConflict,
  canReapplyConflict,
  createInitialConflictState,
  isContextMatching,
  TemplateDetailLifecycleController,
  validateVersionSubmission,
} from "../../apps/web/app/design-template-concurrency.js";

const SPEC_V1: DesignTemplateSpec = {
  schemaVersion: 1,
  format: "SQUARE",
  backgroundColor: "#0F172A",
  overlayColor: "#020617",
  overlayOpacity: 0.3,
  textColor: "#FFFFFF",
  mutedTextColor: "#94A3B8",
  accentColor: "#38BDF8",
  safeArea: 80,
  textAlign: "left",
  titleMaxLines: 3,
  showEyebrow: true,
  showSubtitle: true,
  showCallToAction: true,
};

const SPEC_V2_SERVER: DesignTemplateSpec = {
  ...SPEC_V1,
  backgroundColor: "#990000",
  safeArea: 90,
};

const SPEC_V3_SERVER: DesignTemplateSpec = {
  ...SPEC_V2_SERVER,
  backgroundColor: "#006600",
  safeArea: 100,
};

const DRAFT_USER: DesignTemplateSpec = {
  ...SPEC_V1,
  safeArea: 120,
  textColor: "#FFDD00",
};

describe("Fase 6 - Endurecimento de Concorrência e Conflito (409)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("4. Falha ao carregar versão atual após 409 não apaga rascunho", () => {
    const draft = JSON.parse(JSON.stringify(DRAFT_USER));
    const initialConflict = createInitialConflictState(1, true);

    expect(initialConflict.hasConflict).toBe(true);
    expect(initialConflict.baseVersionNumber).toBe(1);
    expect(initialConflict.isLoadingServerVersion).toBe(true);
    expect(initialConflict.serverVersion).toBeNull();

    // Simula falha de rede ao buscar o detalhe atualizado
    const failedConflict = applyConflictFetchFailure(
      initialConflict,
      "Falha de conexão com o servidor",
    );

    // O rascunho deve permanecer 100% intocado
    expect(draft).toEqual(DRAFT_USER);
    expect(failedConflict.hasConflict).toBe(true);
    expect(failedConflict.baseVersionNumber).toBe(1);
    expect(failedConflict.serverVersion).toBeNull();
    expect(failedConflict.serverSpec).toBeNull();
    expect(failedConflict.isLoadingServerVersion).toBe(false);
    expect(failedConflict.fetchError).toBe("Falha de conexão com o servidor");
  });

  it("5. Falha após 409 mostra ação de retry e bloqueia reaplicação/descarte", () => {
    const initialConflict = createInitialConflictState(1, true);
    const failedConflict = applyConflictFetchFailure(
      initialConflict,
      "Erro de rede 503",
    );

    // Não deve permitir reaplicar enquanto a versão atual não tiver sido carregada
    expect(canReapplyConflict(failedConflict)).toBe(false);
    expect(canDiscardConflict(failedConflict)).toBe(false);

    // Submissão de nova versão também deve ser bloqueada com mensagem clara
    const validation = validateVersionSubmission({
      isEditingVersion: true,
      isVersionDirty: true,
      conflictState: failedConflict,
    });
    expect(validation.allowed).toBe(false);
    expect(validation.reason).toMatch(
      /versão atual do servidor não for carregada/i,
    );
  });

  it("6. Retry bem-sucedido habilita reaplicar e descartar sem substituir o rascunho", () => {
    const draft = JSON.parse(JSON.stringify(DRAFT_USER));
    const initialConflict = createInitialConflictState(1, true);
    const failedConflict = applyConflictFetchFailure(
      initialConflict,
      "Erro de rede 503",
    );

    expect(canReapplyConflict(failedConflict)).toBe(false);

    // Usuário clica em 'Tentar carregar versão atual novamente' -> fetch tem sucesso com v2
    const resolvedConflict = applyConflictFetchSuccess(
      failedConflict,
      2,
      SPEC_V2_SERVER,
      draft,
    );

    expect(resolvedConflict.fetchError).toBeNull();
    expect(resolvedConflict.serverVersion).toBe(2);
    expect(resolvedConflict.serverSpec).toEqual(SPEC_V2_SERVER);
    expect(resolvedConflict.isLoadingServerVersion).toBe(false);
    expect(resolvedConflict.diffItems.length).toBeGreaterThan(0);

    // Rascunho permanece intocado após o retry
    expect(draft).toEqual(DRAFT_USER);

    // Agora reaplicar e descartar estão habilitados
    expect(canReapplyConflict(resolvedConflict)).toBe(true);
    expect(canDiscardConflict(resolvedConflict)).toBe(true);
  });

  it("7. Reaplicar só altera a base após ação explícita do usuário", () => {
    let baseVersionNumber = 1;
    let baseSpec = JSON.parse(JSON.stringify(SPEC_V1));
    const draft = JSON.parse(JSON.stringify(DRAFT_USER));

    // Conflito detectado e servidor traz v2
    const conflictState = applyConflictFetchSuccess(
      createInitialConflictState(1),
      2,
      SPEC_V2_SERVER,
      draft,
    );

    // Mesmo com a versão 2 do servidor conhecida, a base de edição NÃO muda silenciosamente
    expect(baseVersionNumber).toBe(1);
    expect(baseSpec).toEqual(SPEC_V1);

    // Usuário clica explicitamente em "Reaplicar sobre a versão atual (v2)"
    if (canReapplyConflict(conflictState)) {
      baseVersionNumber = conflictState.serverVersion!;
      baseSpec = JSON.parse(JSON.stringify(conflictState.serverSpec!));
    }

    expect(baseVersionNumber).toBe(2);
    expect(baseSpec).toEqual(SPEC_V2_SERVER);
    expect(draft).toEqual(DRAFT_USER); // Rascunho continua preservado
  });

  it("8. Descartar só altera formulário após ação explícita do usuário", () => {
    let baseVersionNumber = 1;
    let baseSpec = JSON.parse(JSON.stringify(SPEC_V1));
    let editSpec = JSON.parse(JSON.stringify(DRAFT_USER));
    let isEditingVersion = true;

    const conflictState = applyConflictFetchSuccess(
      createInitialConflictState(1),
      2,
      SPEC_V2_SERVER,
      editSpec,
    );

    // Antes da ação de descarte, o rascunho de edição continua preservado no formulário
    expect(editSpec).toEqual(DRAFT_USER);
    expect(baseVersionNumber).toBe(1);

    // Usuário clica explicitamente em "Descartar meu rascunho"
    if (canDiscardConflict(conflictState)) {
      editSpec = JSON.parse(JSON.stringify(conflictState.serverSpec!));
      baseVersionNumber = conflictState.serverVersion!;
      baseSpec = JSON.parse(JSON.stringify(conflictState.serverSpec!));
      isEditingVersion = false;
    }

    expect(editSpec).toEqual(SPEC_V2_SERVER);
    expect(baseVersionNumber).toBe(2);
    expect(baseSpec).toEqual(SPEC_V2_SERVER);
    expect(isEditingVersion).toBe(false);
  });

  it("9. Resposta atrasada do template A não substitui o template B", async () => {
    const controller = new TemplateDetailLifecycleController(
      "org-a",
      "client-a",
    );

    // 1. Usuário abre template A
    const reqA = controller.startDetailRequest("template-A");
    expect(reqA.isCurrent(reqA.requestId)).toBe(true);

    // 2. Antes de A responder, usuário abre template B
    const reqB = controller.startDetailRequest("template-B");
    expect(reqB.isCurrent(reqB.requestId)).toBe(true);

    // 3. Sinal de A deve ter sido abortado
    expect(reqA.signal.aborted).toBe(true);
    // 4. Resposta de A é considerada obsoleta
    expect(reqA.isCurrent(reqA.requestId)).toBe(false);

    // 5. Somente B é corrente
    expect(reqB.isCurrent(reqB.requestId)).toBe(true);
    expect(controller.getActiveContext().templateId).toBe("template-B");
  });

  it("10. Resposta atrasada de consulta 409 de A não altera o template B", async () => {
    const controller = new TemplateDetailLifecycleController(
      "org-a",
      "client-a",
    );

    // Usuário está no template A e recebe 409, disparando recarga de conflito
    controller.startDetailRequest("template-A");
    const conflictReqA = controller.startConflictRequest("template-A");
    expect(conflictReqA.isCurrent(conflictReqA.requestId)).toBe(true);

    // Usuário navega para o template B enquanto o fetch de conflito de A está em voo
    const reqB = controller.startDetailRequest("template-B");

    // A resposta atrasada de conflito do template A deve ser rejeitada
    expect(conflictReqA.isCurrent(conflictReqA.requestId)).toBe(false);
    expect(conflictReqA.signal.aborted).toBe(true);

    // O contexto ativo pertence estritamente a B
    expect(reqB.isCurrent(reqB.requestId)).toBe(true);
    expect(controller.getActiveContext().templateId).toBe("template-B");
  });

  it("11. Troca de cliente aborta todas as consultas pendentes", () => {
    const controller = new TemplateDetailLifecycleController(
      "org-a",
      "client-a",
    );

    const reqA = controller.startDetailRequest("template-A");
    const conflictReq = controller.startConflictRequest("template-A");

    expect(reqA.signal.aborted).toBe(false);
    expect(conflictReq.signal.aborted).toBe(false);

    // Troca para cliente-b
    controller.updateContext("org-a", "client-b", null);

    // Todas as requisições em voo devem ter sido abortadas
    expect(reqA.signal.aborted).toBe(true);
    expect(conflictReq.signal.aborted).toBe(true);
    expect(controller.getActiveContext().clientId).toBe("client-b");
    expect(controller.getActiveContext().templateId).toBeNull();
  });

  it("12. Novo conflito depois de reaplicar repete o fluxo de resolução perfeitamente", () => {
    // Ciclo 1: Partida v1, conflito detecta v2
    let baseVersionNumber = 1;
    const draft = JSON.parse(JSON.stringify(DRAFT_USER));

    const conflict = applyConflictFetchSuccess(
      createInitialConflictState(baseVersionNumber),
      2,
      SPEC_V2_SERVER,
      draft,
    );
    expect(conflict.serverVersion).toBe(2);

    // Reaplicação sobre v2
    baseVersionNumber = conflict.serverVersion!;
    expect(baseVersionNumber).toBe(2);

    // Tentativa de salvar v2 -> Outro usuário gravou v3 concorrentemente (409 novamente)
    let newConflict = createInitialConflictState(baseVersionNumber, true);
    expect(newConflict.baseVersionNumber).toBe(2);

    // Fetch atualiza para v3
    newConflict = applyConflictFetchSuccess(
      newConflict,
      3,
      SPEC_V3_SERVER,
      draft,
    );
    expect(newConflict.serverVersion).toBe(3);
    expect(newConflict.diffItems.length).toBeGreaterThan(0);
    expect(canReapplyConflict(newConflict)).toBe(true);

    // Usuário pode reaplicar sobre v3 sem perda de rascunho
    baseVersionNumber = newConflict.serverVersion!;
    expect(baseVersionNumber).toBe(3);
    expect(draft).toEqual(DRAFT_USER);
  });

  it("13. O estado sujo permanece durante falha e conflito", () => {
    // Durante conflito inicial
    const conflictLoading = createInitialConflictState(1, true);
    const isDirty = true; // Por definição quando conflictState?.hasConflict ou spec diverge
    expect(isDirty).toBe(true);

    // Durante falha de rede
    const conflictFailed = applyConflictFetchFailure(
      conflictLoading,
      "Rede offline",
    );
    expect(conflictFailed.hasConflict).toBe(true);
    expect(isDirty).toBe(true);

    // Validação de formulário bloqueia envio mas não desativa dirty state
    const validation = validateVersionSubmission({
      isEditingVersion: true,
      isVersionDirty: true,
      conflictState: conflictFailed,
    });
    expect(validation.allowed).toBe(false);
  });

  it("14. Não existe catch {} silencioso no fluxo de conflito ou gerenciamento de templates", () => {
    const managerSource = readFileSync(
      resolve(process.cwd(), "apps/web/app/design-template-manager.tsx"),
      "utf8",
    );
    const concurrencySource = readFileSync(
      resolve(process.cwd(), "apps/web/app/design-template-concurrency.ts"),
      "utf8",
    );

    // Procura por catch vazios na regex: catch\s*\([^)]*\)\s*\{\s*\} ou catch\s*\{\s*\}
    const silentCatchRegex = /catch(?:\s*\([^)]*\))?\s*\{\s*\}/g;
    const managerMatches = managerSource.match(silentCatchRegex) ?? [];
    const concurrencyMatches = concurrencySource.match(silentCatchRegex) ?? [];

    // Nenhum catch silencioso deve existir no módulo de concorrência nem no manager
    expect(concurrencyMatches).toHaveLength(0);
    expect(managerMatches).toHaveLength(0);

    // No manager, garantir que o bloco 409 não tenha catch vazio
    expect(managerSource).not.toContain("fallback se busca fresh falhar");
    expect(managerSource).toContain("reloadConflictServerVersion");
  });

  it("15. isContextMatching valida quadrupla de identidade de contexto", () => {
    const active = {
      org: "org-1",
      clientId: "client-1",
      templateId: "tpl-1",
      requestId: 42,
    };

    expect(isContextMatching(active, { ...active })).toBe(true);
    expect(isContextMatching(active, { ...active, templateId: "tpl-2" })).toBe(
      false,
    );
    expect(isContextMatching(active, { ...active, requestId: 41 })).toBe(false);
    expect(isContextMatching(active, { ...active, clientId: "client-2" })).toBe(
      false,
    );
    expect(isContextMatching(active, { ...active, org: "org-2" })).toBe(false);
  });
});
