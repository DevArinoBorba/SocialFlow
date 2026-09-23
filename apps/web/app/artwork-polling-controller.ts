export type RenderJobStatus =
  "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface PollingJob {
  id: string;
  status: RenderJobStatus;
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

export interface ArtworkPollingControllerOptions {
  maxAttempts?: number;
  baseIntervalMs?: number;
  hiddenIntervalMs?: number;
  fetchJob: (jobId: string, signal: AbortSignal) => Promise<PollingJob>;
  onJobUpdated: (job: PollingJob) => void;
  onJobCompleted: (job: PollingJob) => void;
  onJobFailed: (job: PollingJob) => void;
  onTimeoutReached: (jobId: string) => void;
  getVisibilityState?: () => "visible" | "hidden";
}

/**
 * Controlador de ciclo de vida de polling determinístico e imune a condições de corrida.
 *
 * Garante:
 * 1. Cancelamento estrito de timers e requisições via AbortController.
 * 2. Invalidação de respostas tardias por número sequencial de geração e ID do job autorizado.
 * 3. Deduplicação única de efeitos colaterais de conclusão (onArtworkCompleted, recarga de mídias e histórico).
 * 4. Interrupção e criação segura de nova geração para consultas manuais.
 * 5. Idempotência e segurança em chamadas repetidas a stopPolling().
 */
export class ArtworkPollingController {
  private generation = 0;
  private authorizedJobId: string | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private attempts = 0;
  private isDisposed = false;
  private completedJobIds = new Set<string>();

  private readonly maxAttempts: number;
  private readonly baseIntervalMs: number;
  private readonly hiddenIntervalMs: number;
  private readonly fetchJob: (
    jobId: string,
    signal: AbortSignal,
  ) => Promise<PollingJob>;
  private readonly onJobUpdated: (job: PollingJob) => void;
  private readonly onJobCompleted: (job: PollingJob) => void;
  private readonly onJobFailed: (job: PollingJob) => void;
  private readonly onTimeoutReached: (jobId: string) => void;
  private readonly getVisibilityState: () => "visible" | "hidden";

  constructor(options: ArtworkPollingControllerOptions) {
    this.maxAttempts = options.maxAttempts ?? 25;
    this.baseIntervalMs = options.baseIntervalMs ?? 1600;
    this.hiddenIntervalMs = options.hiddenIntervalMs ?? 4000;
    this.fetchJob = options.fetchJob;
    this.onJobUpdated = options.onJobUpdated;
    this.onJobCompleted = options.onJobCompleted;
    this.onJobFailed = options.onJobFailed;
    this.onTimeoutReached = options.onTimeoutReached;
    this.getVisibilityState =
      options.getVisibilityState ??
      (() =>
        typeof document !== "undefined" ? document.visibilityState : "visible");
  }

  public getGeneration(): number {
    return this.generation;
  }

  public getAuthorizedJobId(): string | null {
    return this.authorizedJobId;
  }

  public hasTimer(): boolean {
    return this.timerId !== null;
  }

  public hasInFlightRequest(): boolean {
    return this.abortController !== null;
  }

  public isJobMarkedCompleted(jobId: string): boolean {
    return this.completedJobIds.has(jobId);
  }

  public getIsDisposed(): boolean {
    return this.isDisposed;
  }

  /**
   * Interrompe qualquer ciclo de polling ativo.
   * É estritamente idempotente e seguro mesmo quando não há timer ou requisição ativa.
   */
  public stopPolling(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.abortController !== null) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.generation += 1;
    this.authorizedJobId = null;
    this.attempts = 0;
  }

  /**
   * Inicia o acompanhamento automático de um job.
   */
  public startPolling(jobId: string, initialDelayMs?: number): void {
    if (this.isDisposed) return;

    // Interrompe qualquer ciclo anterior e gera nova geração
    this.stopPolling();

    this.authorizedJobId = jobId;
    const cycleGeneration = this.generation;
    this.attempts = 0;

    const delay = initialDelayMs ?? this.calculateDelay();
    this.scheduleNext(jobId, cycleGeneration, delay);
  }

  /**
   * Prepara uma consulta manual ("Atualizar status").
   * Interrompe o polling automático prévio e autoriza uma nova geração para o mesmo job.
   * O acompanhamento permanece em modo manual sem reativar loops automáticos de polling.
   */
  public prepareManualCheck(jobId: string): {
    generation: number;
    signal: AbortSignal;
  } {
    this.stopPolling();

    this.authorizedJobId = jobId;
    const currentGen = this.generation;
    const controller = new AbortController();
    this.abortController = controller;

    return {
      generation: currentGen,
      signal: controller.signal,
    };
  }

  /**
   * Executa a consulta manual de status e aplica a validação de geração.
   */
  public async executeManualCheck(jobId: string): Promise<PollingJob | null> {
    if (this.isDisposed) return null;

    const { generation, signal } = this.prepareManualCheck(jobId);

    try {
      const updated = await this.fetchJob(jobId, signal);

      if (!this.isAuthorized(jobId, generation)) {
        return null;
      }

      this.abortController = null;
      this.handleJobResult(updated);
      return updated;
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") {
        return null;
      }
      if (this.isAuthorized(jobId, generation)) {
        this.abortController = null;
      }
      throw err;
    }
  }

  /**
   * Valida se uma resposta recebida tem autorização para atualizar o estado.
   */
  public isAuthorized(jobId: string, generation: number): boolean {
    if (this.isDisposed) return false;
    return this.authorizedJobId === jobId && this.generation === generation;
  }

  /**
   * Registra a conclusão de um job, garantindo que os efeitos colaterais
   * sejam disparados exatamente uma única vez por ID de job.
   */
  public handleJobCompletion(job: PollingJob): boolean {
    if (this.completedJobIds.has(job.id)) {
      return false;
    }
    this.completedJobIds.add(job.id);
    this.onJobCompleted(job);
    return true;
  }

  /**
   * Libera todos os recursos do controlador (usado ao desmontar o componente).
   */
  public dispose(): void {
    this.isDisposed = true;
    this.stopPolling();
    this.completedJobIds.clear();
  }

  private scheduleNext(
    jobId: string,
    generation: number,
    delayMs: number,
  ): void {
    if (!this.isAuthorized(jobId, generation)) return;

    this.timerId = setTimeout(() => {
      this.timerId = null;
      void this.pollStep(jobId, generation);
    }, delayMs);
  }

  private async pollStep(jobId: string, generation: number): Promise<void> {
    if (!this.isAuthorized(jobId, generation)) return;

    const controller = new AbortController();
    this.abortController = controller;

    try {
      const updated = await this.fetchJob(jobId, controller.signal);

      if (!this.isAuthorized(jobId, generation)) return;

      this.abortController = null;
      this.handleJobResult(updated);

      if (
        updated.status === "COMPLETED" ||
        updated.status === "FAILED" ||
        updated.status === "CANCELLED"
      ) {
        // Encerra polling ao atingir estado terminal
        this.stopPolling();
        return;
      }

      // Ainda em PENDING ou PROCESSING
      this.attempts += 1;
      if (this.attempts >= this.maxAttempts) {
        this.stopPolling();
        this.onTimeoutReached(jobId);
        return;
      }

      this.scheduleNext(jobId, generation, this.calculateDelay());
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") return;
      if (!this.isAuthorized(jobId, generation)) return;

      this.abortController = null;
      this.attempts += 1;

      if (this.attempts >= this.maxAttempts) {
        this.stopPolling();
        this.onTimeoutReached(jobId);
        return;
      }

      // Em erro transitório, tenta novamente com intervalo padrão
      this.scheduleNext(jobId, generation, this.calculateDelay());
    }
  }

  private handleJobResult(job: PollingJob): void {
    this.onJobUpdated(job);

    if (job.status === "COMPLETED") {
      this.handleJobCompletion(job);
    } else if (job.status === "FAILED") {
      this.onJobFailed(job);
    }
  }

  private calculateDelay(): number {
    return this.getVisibilityState() === "hidden"
      ? this.hiddenIntervalMs
      : this.baseIntervalMs;
  }
}

/**
 * Gerenciador de ciclo de vida para instâncias de ArtworkPollingController.
 * Garante compatibilidade estrita com o React Strict Mode, remounts,
 * hot-reloads e trocas de contexto (cliente/organização).
 * Impede que instâncias descartadas continuem ativas ou sejam reutilizadas.
 */
export class PollingLifecycleManager {
  private currentInstance: ArtworkPollingController | null = null;
  private factory: () => ArtworkPollingController;

  constructor(factory: () => ArtworkPollingController) {
    this.factory = factory;
  }

  public updateFactory(newFactory: () => ArtworkPollingController): void {
    this.factory = newFactory;
  }

  public getController(): ArtworkPollingController {
    if (!this.currentInstance || this.currentInstance.getIsDisposed()) {
      this.currentInstance = this.factory();
    }
    return this.currentInstance;
  }

  public onSetup(): ArtworkPollingController {
    if (this.currentInstance && !this.currentInstance.getIsDisposed()) {
      this.currentInstance.dispose();
    }
    const instance = this.factory();
    this.currentInstance = instance;
    return instance;
  }

  public onCleanup(instance: ArtworkPollingController): void {
    instance.dispose();
    if (this.currentInstance === instance) {
      this.currentInstance = null;
    }
  }

  public getCurrentInstance(): ArtworkPollingController | null {
    return this.currentInstance;
  }
}
