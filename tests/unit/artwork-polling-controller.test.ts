import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ArtworkPollingController,
  type PollingJob,
} from "../../apps/web/app/artwork-polling-controller.js";

function makeJob(
  id: string,
  status: PollingJob["status"] = "PENDING",
): PollingJob {
  return {
    id,
    status,
    templateVersionId: "tpl-v1",
    postId: null,
    backgroundMediaAssetId: null,
    logoMediaAssetId: null,
    outputMediaAssetId: status === "COMPLETED" ? "media-1" : null,
    outputMediaUrl: status === "COMPLETED" ? "/media/1/content" : null,
    attemptNumber: 1,
    errorCode: status === "FAILED" ? "RENDER_FAILED" : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: status === "COMPLETED" ? new Date().toISOString() : null,
  };
}

describe("ArtworkPollingController: Concorrência e Ciclo de Vida do Polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("1. stopPolling() é estritamente idempotente e seguro sem timer ou requisição ativa", () => {
    const controller = new ArtworkPollingController({
      fetchJob: vi.fn(),
      onJobUpdated: vi.fn(),
      onJobCompleted: vi.fn(),
      onJobFailed: vi.fn(),
      onTimeoutReached: vi.fn(),
    });

    expect(controller.hasTimer()).toBe(false);
    expect(controller.hasInFlightRequest()).toBe(false);
    expect(controller.getAuthorizedJobId()).toBe(null);

    // Múltiplas chamadas não devem lançar erro
    expect(() => controller.stopPolling()).not.toThrow();
    expect(() => controller.stopPolling()).not.toThrow();
    expect(controller.hasTimer()).toBe(false);
    expect(controller.getAuthorizedJobId()).toBe(null);
  });

  it("2. Timer do job A é cancelado imediatamente ao iniciar acompanhamento do job B", () => {
    const fetchJob = vi.fn().mockResolvedValue(makeJob("job-A", "PROCESSING"));
    const onJobUpdated = vi.fn();

    const controller = new ArtworkPollingController({
      fetchJob,
      onJobUpdated,
      onJobCompleted: vi.fn(),
      onJobFailed: vi.fn(),
      onTimeoutReached: vi.fn(),
      baseIntervalMs: 1000,
    });

    controller.startPolling("job-A");
    expect(controller.getAuthorizedJobId()).toBe("job-A");
    expect(controller.hasTimer()).toBe(true);
    const genA = controller.getGeneration();

    // Inicia Job B antes do timer do Job A disparar
    controller.startPolling("job-B");
    expect(controller.getAuthorizedJobId()).toBe("job-B");
    expect(controller.getGeneration()).toBeGreaterThan(genA);

    // Avança o tempo
    vi.advanceTimersByTime(1000);

    // O fetch deve ter sido chamado para o Job B, nunca para o Job A
    expect(fetchJob).toHaveBeenCalledWith("job-B", expect.any(AbortSignal));
    expect(fetchJob).not.toHaveBeenCalledWith("job-A", expect.any(AbortSignal));
  });

  it("3. Resposta tardia do job A não sobrescreve o job B (invalidação por geração)", async () => {
    let resolveJobA!: (val: PollingJob) => void;
    const pendingPromiseA = new Promise<PollingJob>((resolve) => {
      resolveJobA = resolve;
    });

    const fetchJob = vi.fn().mockImplementation((id: string) => {
      if (id === "job-A") return pendingPromiseA;
      return Promise.resolve(makeJob("job-B", "PROCESSING"));
    });

    const onJobUpdated = vi.fn();

    const controller = new ArtworkPollingController({
      fetchJob,
      onJobUpdated,
      onJobCompleted: vi.fn(),
      onJobFailed: vi.fn(),
      onTimeoutReached: vi.fn(),
    });

    // Inicia Job A e dispara a requisição
    controller.startPolling("job-A", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchJob).toHaveBeenCalledWith("job-A", expect.any(AbortSignal));

    // Usuário inicia Job B enquanto Job A ainda está pendente na rede
    controller.startPolling("job-B", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchJob).toHaveBeenCalledWith("job-B", expect.any(AbortSignal));
    expect(onJobUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-B" }),
    );

    // Resposta do Job A chega tardiamente
    onJobUpdated.mockClear();
    resolveJobA(makeJob("job-A", "COMPLETED"));
    await Promise.resolve(); // flush microtasks

    // Job A NÃO pode atualizar o estado pois sua geração foi invalidada
    expect(onJobUpdated).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-A" }),
    );
  });

  it("4. Timer e requisição são cancelados ao acionar 'Nova arte' (stopPolling)", async () => {
    let signalReceived: AbortSignal | null = null;
    const fetchJob = vi
      .fn()
      .mockImplementation((_id: string, signal: AbortSignal) => {
        signalReceived = signal;
        return new Promise(() => {}); // never resolves
      });

    const onJobUpdated = vi.fn();
    const controller = new ArtworkPollingController({
      fetchJob,
      onJobUpdated,
      onJobCompleted: vi.fn(),
      onJobFailed: vi.fn(),
      onTimeoutReached: vi.fn(),
    });

    controller.startPolling("job-active", 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(signalReceived).not.toBeNull();
    expect(signalReceived!.aborted).toBe(false);

    // Usuário clica em "Nova arte" -> invoca stopPolling()
    controller.stopPolling();

    expect(signalReceived!.aborted).toBe(true);
    expect(controller.hasTimer()).toBe(false);
    expect(controller.getAuthorizedJobId()).toBe(null);
  });

  it("5. Resposta tardia depois de 'Nova arte' não restaura o job anterior", async () => {
    let resolveJob!: (val: PollingJob) => void;
    const fetchJob = vi.fn().mockImplementation(() => {
      return new Promise<PollingJob>((resolve) => {
        resolveJob = resolve;
      });
    });

    const onJobUpdated = vi.fn();
    const onJobCompleted = vi.fn();

    const controller = new ArtworkPollingController({
      fetchJob,
      onJobUpdated,
      onJobCompleted,
      onJobFailed: vi.fn(),
      onTimeoutReached: vi.fn(),
    });

    controller.startPolling("job-1", 0);
    await vi.advanceTimersByTimeAsync(0);

    // Usuário clica em "Nova arte"
    controller.stopPolling();

    // Resposta chega após a limpeza
    resolveJob(makeJob("job-1", "COMPLETED"));
    await Promise.resolve();

    expect(onJobUpdated).not.toHaveBeenCalled();
    expect(onJobCompleted).not.toHaveBeenCalled();
  });

  it("6. Consulta manual cria nova geração autorizada para o mesmo job após interromper polling automático", async () => {
    const fetchJob = vi.fn().mockResolvedValue(makeJob("job-1", "PROCESSING"));
    const onJobUpdated = vi.fn();

    const controller = new ArtworkPollingController({
      fetchJob,
      onJobUpdated,
      onJobCompleted: vi.fn(),
      onJobFailed: vi.fn(),
      onTimeoutReached: vi.fn(),
      baseIntervalMs: 2000,
    });

    // Inicia polling automático
    controller.startPolling("job-1");
    const initialGen = controller.getGeneration();
    expect(controller.hasTimer()).toBe(true);

    // Usuário clica em "Atualizar status" manualmente
    const manualResultPromise = controller.executeManualCheck("job-1");

    // O timer automático anterior foi cancelado
    expect(controller.hasTimer()).toBe(false);
    // A geração avançou
    expect(controller.getGeneration()).toBeGreaterThan(initialGen);
    // O job continua autorizado sob a nova geração
    expect(controller.getAuthorizedJobId()).toBe("job-1");

    const result = await manualResultPromise;
    expect(result).not.toBeNull();
    expect(result?.id).toBe("job-1");
    expect(onJobUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1" }),
    );
  });

  it("7. COMPLETED observado simultaneamente por dois caminhos dispara efeitos de conclusão apenas uma vez", async () => {
    const completedJob = makeJob("job-dup", "COMPLETED");
    const onJobCompleted = vi.fn();

    const controller = new ArtworkPollingController({
      fetchJob: vi.fn().mockResolvedValue(completedJob),
      onJobUpdated: vi.fn(),
      onJobCompleted,
      onJobFailed: vi.fn(),
      onTimeoutReached: vi.fn(),
    });

    // Simula duas observações de conclusão concorrentes
    const firstCall = controller.handleJobCompletion(completedJob);
    const secondCall = controller.handleJobCompletion(completedJob);

    expect(firstCall).toBe(true);
    expect(secondCall).toBe(false);
    expect(onJobCompleted).toHaveBeenCalledTimes(1);
    expect(controller.isJobMarkedCompleted("job-dup")).toBe(true);
  });

  it("8. Job já concluído pode continuar aparecendo no histórico sem repetir efeitos", () => {
    const completedJob = makeJob("job-history", "COMPLETED");
    const onJobCompleted = vi.fn();

    const controller = new ArtworkPollingController({
      fetchJob: vi.fn(),
      onJobUpdated: vi.fn(),
      onJobCompleted,
      onJobFailed: vi.fn(),
      onTimeoutReached: vi.fn(),
    });

    // Primeira conclusão
    controller.handleJobCompletion(completedJob);
    expect(onJobCompleted).toHaveBeenCalledTimes(1);

    // Recarga posterior de histórico ou consulta avulsa com mesmo ID
    controller.handleJobCompletion(completedJob);
    expect(onJobCompleted).toHaveBeenCalledTimes(1); // Não duplicou
  });

  it("9. Polling para definitivamente em COMPLETED", async () => {
    const fetchJob = vi
      .fn()
      .mockResolvedValue(makeJob("job-comp", "COMPLETED"));
    const onJobCompleted = vi.fn();

    const controller = new ArtworkPollingController({
      fetchJob,
      onJobUpdated: vi.fn(),
      onJobCompleted,
      onJobFailed: vi.fn(),
      onTimeoutReached: vi.fn(),
    });

    controller.startPolling("job-comp", 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchJob).toHaveBeenCalledTimes(1);
    expect(onJobCompleted).toHaveBeenCalledTimes(1);
    expect(controller.hasTimer()).toBe(false);
    expect(controller.getAuthorizedJobId()).toBe(null);

    // Avança o tempo adicional para garantir que nenhum outro poll foi agendado
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchJob).toHaveBeenCalledTimes(1);
  });

  it("10. Polling para definitivamente em FAILED", async () => {
    const fetchJob = vi.fn().mockResolvedValue(makeJob("job-fail", "FAILED"));
    const onJobFailed = vi.fn();

    const controller = new ArtworkPollingController({
      fetchJob,
      onJobUpdated: vi.fn(),
      onJobCompleted: vi.fn(),
      onJobFailed,
      onTimeoutReached: vi.fn(),
    });

    controller.startPolling("job-fail", 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchJob).toHaveBeenCalledTimes(1);
    expect(onJobFailed).toHaveBeenCalledTimes(1);
    expect(controller.hasTimer()).toBe(false);
    expect(controller.getAuthorizedJobId()).toBe(null);

    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchJob).toHaveBeenCalledTimes(1);
  });

  it("11. Limite local de tentativas (maxAttempts) interrompe o polling sem marcar como FAILED", async () => {
    const fetchJob = vi
      .fn()
      .mockResolvedValue(makeJob("job-timeout", "PROCESSING"));
    const onTimeoutReached = vi.fn();
    const onJobFailed = vi.fn();

    const controller = new ArtworkPollingController({
      fetchJob,
      onJobUpdated: vi.fn(),
      onJobCompleted: vi.fn(),
      onJobFailed,
      onTimeoutReached,
      maxAttempts: 3,
      baseIntervalMs: 500,
    });

    controller.startPolling("job-timeout", 0);

    // Attempt 1
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchJob).toHaveBeenCalledTimes(1);

    // Attempt 2
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchJob).toHaveBeenCalledTimes(2);

    // Attempt 3 -> atinge o limite
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchJob).toHaveBeenCalledTimes(3);

    expect(onTimeoutReached).toHaveBeenCalledWith("job-timeout");
    expect(onJobFailed).not.toHaveBeenCalled();
    expect(controller.hasTimer()).toBe(false);
  });

  it("12. Depois de atingir o limite local, a consulta manual continua disponível", async () => {
    const fetchJob = vi
      .fn()
      .mockResolvedValue(makeJob("job-timeout", "PROCESSING"));
    const onTimeoutReached = vi.fn();

    const controller = new ArtworkPollingController({
      fetchJob,
      onJobUpdated: vi.fn(),
      onJobCompleted: vi.fn(),
      onJobFailed: vi.fn(),
      onTimeoutReached,
      maxAttempts: 1,
    });

    controller.startPolling("job-timeout", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTimeoutReached).toHaveBeenCalled();

    // Consulta manual posterior
    fetchJob.mockResolvedValueOnce(makeJob("job-timeout", "COMPLETED"));
    const manualResult = await controller.executeManualCheck("job-timeout");

    expect(manualResult?.status).toBe("COMPLETED");
  });

  it("13. Desmontagem (dispose) cancela timers e requisições e impede atualizações futuras", async () => {
    const fetchJob = vi
      .fn()
      .mockResolvedValue(makeJob("job-disp", "PROCESSING"));
    const onJobUpdated = vi.fn();

    const controller = new ArtworkPollingController({
      fetchJob,
      onJobUpdated,
      onJobCompleted: vi.fn(),
      onJobFailed: vi.fn(),
      onTimeoutReached: vi.fn(),
    });

    controller.startPolling("job-disp", 1000);
    expect(controller.hasTimer()).toBe(true);

    controller.dispose();
    expect(controller.hasTimer()).toBe(false);
    expect(controller.getAuthorizedJobId()).toBe(null);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchJob).not.toHaveBeenCalled();
    expect(onJobUpdated).not.toHaveBeenCalled();
  });

  it("14. Troca de contexto (cliente ou modelo) invalida o polling anterior", async () => {
    let resolveContextA!: (job: PollingJob) => void;
    const fetchJob = vi.fn().mockImplementation(() => {
      return new Promise<PollingJob>((res) => {
        resolveContextA = res;
      });
    });

    const onJobUpdated = vi.fn();
    const controller = new ArtworkPollingController({
      fetchJob,
      onJobUpdated,
      onJobCompleted: vi.fn(),
      onJobFailed: vi.fn(),
      onTimeoutReached: vi.fn(),
    });

    // Inicia no Cliente A
    controller.startPolling("job-client-A", 0);
    await vi.advanceTimersByTimeAsync(0);

    // Usuário troca para o Cliente B (ou troca de modelo)
    controller.stopPolling();

    // Resposta do Cliente A chega após a troca
    resolveContextA(makeJob("job-client-A", "PROCESSING"));
    await Promise.resolve();

    expect(onJobUpdated).not.toHaveBeenCalled();
    expect(controller.getAuthorizedJobId()).toBe(null);
  });
});
