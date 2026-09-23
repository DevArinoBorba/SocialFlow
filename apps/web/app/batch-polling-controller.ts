import type { RenderBatchDto } from "@socialflow/contracts";

export interface BatchPollingControllerOptions {
  maxAttempts?: number;
  baseIntervalMs?: number;
  hiddenIntervalMs?: number;
  fetchBatch: (batchId: string, signal: AbortSignal) => Promise<RenderBatchDto>;
  onBatchUpdated: (batch: RenderBatchDto) => void;
  onBatchTerminal: (batch: RenderBatchDto) => void;
  onTimeoutReached?: (batchId: string) => void;
  getVisibilityState?: () => "visible" | "hidden";
}

/**
 * Controlador de ciclo de vida de polling para RenderBatch.
 *
 * Garante:
 * 1. Cancelamento estrito de timers e requisições via AbortController.
 * 2. Invalidação de respostas tardias por número sequencial de geração e batchId autorizado.
 * 3. Parada automática e deduplicação de efeitos em status terminal (COMPLETED, PARTIALLY_FAILED, FAILED, CANCELLED).
 * 4. Backoff adaptativo quando a aba está em background.
 * 5. Idempotência em stopPolling() e dispose().
 */
export class BatchPollingController {
  private generation = 0;
  private authorizedBatchId: string | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private attempts = 0;
  private isDisposed = false;
  private terminalBatchIds = new Set<string>();

  private readonly maxAttempts: number;
  private readonly baseIntervalMs: number;
  private readonly hiddenIntervalMs: number;
  private readonly fetchBatch: (
    batchId: string,
    signal: AbortSignal,
  ) => Promise<RenderBatchDto>;
  private readonly onBatchUpdated: (batch: RenderBatchDto) => void;
  private readonly onBatchTerminal: (batch: RenderBatchDto) => void;
  private readonly onTimeoutReached?: (batchId: string) => void;
  private readonly getVisibilityState: () => "visible" | "hidden";

  constructor(options: BatchPollingControllerOptions) {
    this.maxAttempts = options.maxAttempts ?? 300;
    this.baseIntervalMs = options.baseIntervalMs ?? 1800;
    this.hiddenIntervalMs = options.hiddenIntervalMs ?? 4500;
    this.fetchBatch = options.fetchBatch;
    this.onBatchUpdated = options.onBatchUpdated;
    this.onBatchTerminal = options.onBatchTerminal;
    this.onTimeoutReached = options.onTimeoutReached;
    this.getVisibilityState =
      options.getVisibilityState ??
      (() =>
        typeof document !== "undefined" ? document.visibilityState : "visible");
  }

  public getGeneration(): number {
    return this.generation;
  }

  public getAuthorizedBatchId(): string | null {
    return this.authorizedBatchId;
  }

  public hasTimer(): boolean {
    return this.timerId !== null;
  }

  public hasInFlightRequest(): boolean {
    return this.abortController !== null;
  }

  public isBatchTerminal(batchId: string): boolean {
    return this.terminalBatchIds.has(batchId);
  }

  public getIsDisposed(): boolean {
    return this.isDisposed;
  }

  public startPolling(batchId: string): void {
    if (this.isDisposed) return;

    this.stopPolling();
    this.generation += 1;
    this.authorizedBatchId = batchId;
    this.attempts = 0;

    this.scheduleNextTick(this.generation, batchId, 0);
  }

  public stopPolling(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.abortController !== null) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.authorizedBatchId = null;
  }

  public dispose(): void {
    this.isDisposed = true;
    this.stopPolling();
    this.terminalBatchIds.clear();
  }

  private scheduleNextTick(
    gen: number,
    batchId: string,
    delayMs: number,
  ): void {
    if (this.isDisposed || this.generation !== gen) return;

    this.timerId = setTimeout(() => {
      this.timerId = null;
      void this.executeTick(gen, batchId);
    }, delayMs);
  }

  private async executeTick(gen: number, batchId: string): Promise<void> {
    if (
      this.isDisposed ||
      this.generation !== gen ||
      this.authorizedBatchId !== batchId
    ) {
      return;
    }

    if (this.attempts >= this.maxAttempts) {
      this.stopPolling();
      if (this.onTimeoutReached) {
        this.onTimeoutReached(batchId);
      }
      return;
    }

    this.attempts += 1;
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    try {
      const batch = await this.fetchBatch(batchId, signal);

      if (
        this.isDisposed ||
        this.generation !== gen ||
        this.authorizedBatchId !== batchId
      ) {
        return;
      }

      this.onBatchUpdated(batch);

      const isTerminal =
        batch.status === "COMPLETED" ||
        batch.status === "PARTIALLY_FAILED" ||
        batch.status === "FAILED" ||
        batch.status === "CANCELLED";

      if (isTerminal) {
        if (!this.terminalBatchIds.has(batchId)) {
          this.terminalBatchIds.add(batchId);
          this.onBatchTerminal(batch);
        }
        this.stopPolling();
        return;
      }

      const isHidden = this.getVisibilityState() === "hidden";
      const nextDelay = isHidden ? this.hiddenIntervalMs : this.baseIntervalMs;
      this.scheduleNextTick(gen, batchId, nextDelay);
    } catch {
      if (signal.aborted) return;
      if (
        this.isDisposed ||
        this.generation !== gen ||
        this.authorizedBatchId !== batchId
      ) {
        return;
      }

      // Em erro de rede/transiente, tenta novamente com intervalo
      const nextDelay = this.baseIntervalMs * 1.5;
      this.scheduleNextTick(gen, batchId, nextDelay);
    } finally {
      this.abortController = null;
    }
  }
}
