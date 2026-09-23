import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  renderBatchCreateSchema,
  renderBatchValidateSchema,
  renderBatchListQuerySchema,
  renderBatchItemsQuerySchema,
  renderBatchStatuses,
  type RenderBatchStatus,
  renderJobStatuses,
  computeBatchAggregateStatus,
} from "../../packages/contracts/src/design.js";
import { computeBatchRequestFingerprint } from "../../packages/render/src/index.js";

describe("RenderBatch Contracts and Validation", () => {
  const validUUID1 = randomUUID();
  const validUUID2 = randomUUID();
  const validTemplateVersionId = randomUUID();

  it("validates valid POSTS_SELECTION batch creation payload", () => {
    const payload = {
      templateVersionId: validTemplateVersionId,
      format: "SQUARE",
      source: {
        type: "POSTS_SELECTION",
        postIds: [validUUID1, validUUID2],
      },
      idempotencyKey: "test-idempotency-key-batch-12345",
    };

    const parsed = renderBatchCreateSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.format).toBe("SQUARE");
      expect(parsed.data.source.type).toBe("POSTS_SELECTION");
    }
  });

  it("validates valid CONTENT_BATCH batch creation payload", () => {
    const payload = {
      templateVersionId: validTemplateVersionId,
      format: "STORY",
      source: {
        type: "CONTENT_BATCH",
        contentBatchId: validUUID1,
      },
      defaults: {
        backgroundMediaAssetId: validUUID2,
        logoMediaAssetId: null,
      },
      idempotencyKey: "test-idempotency-key-content-batch-12345",
    };

    const parsed = renderBatchCreateSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.format).toBe("STORY");
      expect(parsed.data.source.type).toBe("CONTENT_BATCH");
      expect(parsed.data.defaults?.backgroundMediaAssetId).toBe(validUUID2);
      expect(parsed.data.defaults?.logoMediaAssetId).toBeNull();
    }
  });

  it("rejects empty postIds in POSTS_SELECTION", () => {
    const payload = {
      templateVersionId: validTemplateVersionId,
      format: "PORTRAIT",
      source: {
        type: "POSTS_SELECTION",
        postIds: [],
      },
      idempotencyKey: "test-idempotency-key-empty-12345",
    };

    const parsed = renderBatchCreateSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });

  it("rejects more than 100 postIds in POSTS_SELECTION", () => {
    const postIds = Array.from(
      { length: 101 },
      (_, i) => `c0000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    );

    const payload = {
      templateVersionId: validTemplateVersionId,
      format: "SQUARE",
      source: {
        type: "POSTS_SELECTION",
        postIds,
      },
      idempotencyKey: "test-idempotency-key-too-many-12345",
    };

    const parsed = renderBatchCreateSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });

  it("rejects short or invalid idempotency keys", () => {
    const payload = {
      templateVersionId: validTemplateVersionId,
      format: "SQUARE",
      source: {
        type: "POSTS_SELECTION",
        postIds: [validUUID1],
      },
      idempotencyKey: "short",
    };

    const parsed = renderBatchCreateSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });

  it("validates validate payload without idempotency key", () => {
    const payload = {
      templateVersionId: validTemplateVersionId,
      format: "PORTRAIT",
      source: {
        type: "POSTS_SELECTION",
        postIds: [validUUID1],
      },
    };

    const parsed = renderBatchValidateSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("validates query parameters with coercions and defaults", () => {
    const query = {
      limit: "15",
      status: "COMPLETED",
    };

    const parsed = renderBatchListQuerySchema.safeParse(query);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.limit).toBe(15);
      expect(parsed.data.status).toBe("COMPLETED");
    }
  });

  it("validates batch items query parameters with coercions and status filter", () => {
    const query = {
      limit: "30",
      status: "CANCELLED",
    };

    const parsed = renderBatchItemsQuerySchema.safeParse(query);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.limit).toBe(30);
      expect(parsed.data.status).toBe("CANCELLED");
    }
  });

  it("includes CANCELLED and CANCELLING in renderBatchStatuses", () => {
    expect(renderJobStatuses).toContain("CANCELLED");
    expect(renderBatchStatuses).toContain("CANCELLING");
    expect(renderBatchStatuses).toContain("CANCELLED");
    expect(renderBatchStatuses).toContain("PARTIALLY_FAILED");
  });

  describe("computeBatchAggregateStatus (pure function)", () => {
    const testCases: Array<{
      description: string;
      input: {
        totalItems: number;
        pendingItems: number;
        processingItems: number;
        completedItems: number;
        failedItems: number;
        cancelledItems: number;
        cancelRequestedAt?: Date | string | null;
      };
      expected: RenderBatchStatus;
    }> = [
      // 1. PENDING puro
      {
        description: "PENDING puro (todos os itens pendentes)",
        input: {
          totalItems: 5,
          pendingItems: 5,
          processingItems: 0,
          completedItems: 0,
          failedItems: 0,
          cancelledItems: 0,
          cancelRequestedAt: null,
        },
        expected: "PENDING",
      },
      // 2. PROCESSING
      {
        description: "PROCESSING (algum item em processamento)",
        input: {
          totalItems: 5,
          pendingItems: 3,
          processingItems: 1,
          completedItems: 1,
          failedItems: 0,
          cancelledItems: 0,
          cancelRequestedAt: null,
        },
        expected: "PROCESSING",
      },
      // 3. CANCELLING
      {
        description:
          "CANCELLING (cancelRequestedAt presente e itens ainda ativos)",
        input: {
          totalItems: 5,
          pendingItems: 2,
          processingItems: 1,
          completedItems: 2,
          failedItems: 0,
          cancelledItems: 0,
          cancelRequestedAt: new Date(),
        },
        expected: "CANCELLING",
      },
      // 4. COMPLETED puro
      {
        description: "COMPLETED puro (todos os itens concluídos com sucesso)",
        input: {
          totalItems: 10,
          pendingItems: 0,
          processingItems: 0,
          completedItems: 10,
          failedItems: 0,
          cancelledItems: 0,
          cancelRequestedAt: null,
        },
        expected: "COMPLETED",
      },
      // 5. FAILED puro
      {
        description: "FAILED puro (todos os itens falharam)",
        input: {
          totalItems: 10,
          pendingItems: 0,
          processingItems: 0,
          completedItems: 0,
          failedItems: 10,
          cancelledItems: 0,
          cancelRequestedAt: null,
        },
        expected: "FAILED",
      },
      // 6. CANCELLED puro
      {
        description: "CANCELLED puro (todos os itens cancelados)",
        input: {
          totalItems: 10,
          pendingItems: 0,
          processingItems: 0,
          completedItems: 0,
          failedItems: 0,
          cancelledItems: 10,
          cancelRequestedAt: new Date(),
        },
        expected: "CANCELLED",
      },
      // 7. COMPLETED + FAILED
      {
        description: "COMPLETED + FAILED -> PARTIALLY_FAILED",
        input: {
          totalItems: 10,
          pendingItems: 0,
          processingItems: 0,
          completedItems: 7,
          failedItems: 3,
          cancelledItems: 0,
          cancelRequestedAt: null,
        },
        expected: "PARTIALLY_FAILED",
      },
      // 8. COMPLETED + CANCELLED
      {
        description:
          "COMPLETED + CANCELLED (sem FAILED) -> CANCELLED (preserva resultados)",
        input: {
          totalItems: 10,
          pendingItems: 0,
          processingItems: 0,
          completedItems: 7,
          failedItems: 0,
          cancelledItems: 3,
          cancelRequestedAt: new Date(),
        },
        expected: "CANCELLED",
      },
      // 9. FAILED + CANCELLED
      {
        description: "FAILED + CANCELLED -> PARTIALLY_FAILED",
        input: {
          totalItems: 5,
          pendingItems: 0,
          processingItems: 0,
          completedItems: 0,
          failedItems: 2,
          cancelledItems: 3,
          cancelRequestedAt: new Date(),
        },
        expected: "PARTIALLY_FAILED",
      },
      // 10. COMPLETED + FAILED + CANCELLED
      {
        description:
          "COMPLETED + FAILED + CANCELLED -> PARTIALLY_FAILED (não mascara falha)",
        input: {
          totalItems: 10,
          pendingItems: 0,
          processingItems: 0,
          completedItems: 5,
          failedItems: 2,
          cancelledItems: 3,
          cancelRequestedAt: new Date(),
        },
        expected: "PARTIALLY_FAILED",
      },
      // 11. Contadores inconsistentes (soma !== totalItems)
      {
        description:
          "Contadores inconsistentes sem cancelamento -> PROCESSING (recuperável pelo reconciliador)",
        input: {
          totalItems: 10,
          pendingItems: 0,
          processingItems: 0,
          completedItems: 5,
          failedItems: 0,
          cancelledItems: 0, // soma = 5 !== 10
          cancelRequestedAt: null,
        },
        expected: "PROCESSING",
      },
      {
        description:
          "Contadores inconsistentes com cancelamento -> CANCELLING (não produz terminal enganoso)",
        input: {
          totalItems: 10,
          pendingItems: 0,
          processingItems: 0,
          completedItems: 4,
          failedItems: 0,
          cancelledItems: 0, // soma = 4 !== 10
          cancelRequestedAt: new Date(),
        },
        expected: "CANCELLING",
      },
    ];

    for (const tc of testCases) {
      it(`tabela: ${tc.description}`, () => {
        const actual = computeBatchAggregateStatus(tc.input);
        expect(actual).toBe(tc.expected);
      });
    }
  });

  describe("computeBatchRequestFingerprint", () => {
    it("produces deterministic SHA-256 independent of key order or postId permutation", () => {
      const fp1 = computeBatchRequestFingerprint({
        organizationId: "org-1",
        clientId: "client-1",
        templateVersionId: "ver-1",
        format: "SQUARE",
        sourceType: "POSTS_SELECTION",
        resolvedPostIds: ["post-b", "post-a", "post-c"],
        defaults: { backgroundMediaAssetId: "bg-1", logoMediaAssetId: null },
      });

      const fp2 = computeBatchRequestFingerprint({
        sourceType: "POSTS_SELECTION",
        format: "SQUARE",
        clientId: "client-1",
        organizationId: "org-1",
        resolvedPostIds: ["post-a", "post-c", "post-b"],
        defaults: { logoMediaAssetId: null, backgroundMediaAssetId: "bg-1" },
        templateVersionId: "ver-1",
      });

      expect(fp1).toBe(fp2);
      expect(fp1).toMatch(/^[a-f0-9]{64}$/);

      // Different param alters fingerprint
      const fpDiff = computeBatchRequestFingerprint({
        organizationId: "org-1",
        clientId: "client-1",
        templateVersionId: "ver-2",
        format: "SQUARE",
        sourceType: "POSTS_SELECTION",
        resolvedPostIds: ["post-a", "post-b", "post-c"],
      });
      expect(fpDiff).not.toBe(fp1);
    });
  });
});
