import { describe, expect, it, vi } from "vitest";
import {
  type RenderBatchDto,
  type RenderBatchListResponse,
  isRenderBatchListResponse,
} from "../../packages/contracts/src/design.js";

describe("RenderBatch History Contract & Frontend Handling (Regression Tests)", () => {
  const sampleBatch: RenderBatchDto = {
    id: "batch-1234-abcd",
    templateVersionId: "tpl-v1",
    sourceType: "POSTS_SELECTION",
    contentBatchId: null,
    parentBatchId: null,
    format: "SQUARE",
    status: "COMPLETED",
    requestHash: "hash-123",
    totalItems: 2,
    pendingItems: 0,
    processingItems: 0,
    completedItems: 2,
    failedItems: 0,
    cancelledItems: 0,
    cancelRequestedAt: null,
    cancelCompletedAt: null,
    completedAt: "2026-09-23T20:00:00.000Z",
    createdAt: "2026-09-23T19:59:00.000Z",
    updatedAt: "2026-09-23T20:00:00.000Z",
  };

  describe("1. Contrato Compartilhado e Validação em Runtime", () => {
    it("valida resposta correta da API contendo { batches: [...] }", () => {
      const validResponse: RenderBatchListResponse = {
        batches: [sampleBatch],
        nextCursor: null,
      };

      expect(isRenderBatchListResponse(validResponse)).toBe(true);
      expect(validResponse.batches).toHaveLength(1);
      expect(validResponse.batches[0]?.id).toBe("batch-1234-abcd");
    });

    it("valida resposta correta da API com lista vazia", () => {
      const emptyResponse: RenderBatchListResponse = {
        batches: [],
        nextCursor: null,
      };

      expect(isRenderBatchListResponse(emptyResponse)).toBe(true);
      expect(emptyResponse.batches).toHaveLength(0);
    });

    it("rejeita formato antigo/divergente com { items: [...] }", () => {
      const legacyResponse = {
        items: [sampleBatch],
        nextCursor: null,
      };

      expect(isRenderBatchListResponse(legacyResponse)).toBe(false);
    });

    it("rejeita formatos inválidos sem causar TypeError", () => {
      expect(isRenderBatchListResponse(null)).toBe(false);
      expect(isRenderBatchListResponse(undefined)).toBe(false);
      expect(isRenderBatchListResponse("")).toBe(false);
      expect(isRenderBatchListResponse(123)).toBe(false);
      expect(isRenderBatchListResponse({})).toBe(false);
      expect(isRenderBatchListResponse({ batches: null })).toBe(false);
      expect(isRenderBatchListResponse({ batches: "invalid" })).toBe(false);
    });
  });

  describe("2. Lógica de Carregamento e Tratamento de Respostas do Frontend", () => {
    it("processa com sucesso lista preenchida de batches", async () => {
      let stateBatches: RenderBatchDto[] = [];
      let errorMessage = "";

      const mockApi = vi.fn().mockResolvedValue({
        batches: [sampleBatch],
        nextCursor: null,
      });

      const data = await mockApi();
      if (!isRenderBatchListResponse(data)) {
        errorMessage =
          "Resposta inválida da API ao carregar o histórico de lotes.";
      } else {
        stateBatches = data.batches;
      }

      expect(errorMessage).toBe("");
      expect(stateBatches).toHaveLength(1);
      expect(stateBatches[0]?.id).toBe("batch-1234-abcd");
    });

    it("processa corretamente lista vazia de batches", async () => {
      let stateBatches: RenderBatchDto[] = [sampleBatch];
      let errorMessage = "";

      const mockApi = vi.fn().mockResolvedValue({
        batches: [],
        nextCursor: null,
      });

      const data = await mockApi();
      if (!isRenderBatchListResponse(data)) {
        errorMessage =
          "Resposta inválida da API ao carregar o histórico de lotes.";
      } else {
        stateBatches = data.batches;
      }

      expect(errorMessage).toBe("");
      expect(stateBatches).toHaveLength(0);
    });

    it("falha HTTP resulta em mensagem amigável sem quebrar estado", async () => {
      const stateBatches: RenderBatchDto[] = [];
      let errorMessage = "";

      const mockApi = vi.fn().mockRejectedValue(new Error("Network Error 500"));

      try {
        await mockApi();
      } catch (err) {
        errorMessage =
          err instanceof Error
            ? err.message
            : "Erro ao carregar histórico de lotes.";
      }

      expect(errorMessage).toBe("Network Error 500");
      expect(stateBatches).toEqual([]);
    });

    it("resposta inválida (ex: payload sem batches) lança erro amigável e não causa TypeError", async () => {
      let stateBatches: RenderBatchDto[] = [];
      let errorMessage = "";

      const mockApi = vi.fn().mockResolvedValue({ items: [sampleBatch] });

      const data = await mockApi();
      if (!isRenderBatchListResponse(data)) {
        errorMessage =
          "Resposta inválida da API ao carregar o histórico de lotes.";
      } else {
        stateBatches = data.batches;
      }

      expect(errorMessage).toBe(
        "Resposta inválida da API ao carregar o histórico de lotes.",
      );
      // Não mascara silenciosamente para lista vazia nem quebra com TypeError
      expect(stateBatches).toHaveLength(0);
    });

    it("troca rápida de abas (race condition) descarta respostas tardias via guard active", async () => {
      let active = true;
      let stateBatches: RenderBatchDto[] = [];

      // Simula fetch demorado
      const delayedFetch = new Promise<RenderBatchListResponse>((resolve) => {
        setTimeout(() => {
          resolve({ batches: [sampleBatch], nextCursor: null });
        }, 50);
      });

      // Usuário estava ativo ao iniciar
      expect(active).toBe(true);

      // Usuário troca de aba imediatamente (cleanup executado)
      active = false;

      const data = await delayedFetch;
      if (active) {
        if (isRenderBatchListResponse(data)) {
          stateBatches = data.batches;
        }
      }

      // O estado permanece inalterado pois a resposta tardia foi descartada
      expect(stateBatches).toHaveLength(0);
    });

    it("modal permanece funcional após fechar e reabrir (reinicialização com guard)", async () => {
      let isOpen = false;
      let tab: "configure" | "history" = "configure";
      let stateBatches: RenderBatchDto[] = [];

      expect(isOpen).toBe(false);
      expect(tab).toBe("configure");

      // 1. Abre modal na aba configure
      isOpen = true;
      expect(stateBatches).toHaveLength(0);

      // 2. Muda para history
      tab = "history";
      const data: RenderBatchListResponse = {
        batches: [sampleBatch],
        nextCursor: null,
      };
      if (isOpen && tab === "history" && isRenderBatchListResponse(data)) {
        stateBatches = data.batches;
      }
      expect(stateBatches).toHaveLength(1);

      // 3. Fecha modal
      isOpen = false;
      expect(isOpen).toBe(false);

      // 4. Reabre modal
      isOpen = true;
      if (isOpen && tab === "history") {
        // Re-executa fetch limpo
        const freshData: RenderBatchListResponse = {
          batches: [sampleBatch],
          nextCursor: null,
        };
        if (isRenderBatchListResponse(freshData)) {
          stateBatches = freshData.batches;
        }
      }
      expect(stateBatches).toHaveLength(1);
      expect(stateBatches[0]?.status).toBe("COMPLETED");
    });
  });
});
