import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  asActor,
  assertRuntimeRole,
  createDatabase,
} from "../../packages/db/src/index.js";

const runtime = createDatabase(process.env.DATABASE_URL!);
const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);

const templateSpec = {
  schemaVersion: 1,
  format: "SQUARE",
  backgroundColor: "#123B35",
  overlayColor: "#071F1C",
  overlayOpacity: 0.35,
  textColor: "#FFFFFF",
  mutedTextColor: "#D6E4DF",
  accentColor: "#E9C46A",
  safeArea: 80,
  textAlign: "left",
  titleMaxLines: 3,
  showEyebrow: true,
  showSubtitle: true,
  showCallToAction: true,
};

beforeAll(async () => {
  await runtime.$connect();
  await assertRuntimeRole(runtime);
});

afterAll(async () => {
  await runtime.$disconnect();
  await migration.$disconnect();
});

describe("RenderBatch Foundation RLS, RBAC and Scope Protection", () => {
  it("forces RLS on RenderBatch", async () => {
    const rows = await migration.$queryRawUnsafe<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"RenderBatch"'::regclass`,
    );
    expect(rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
  });

  it("isolates RenderBatch across tenants", async () => {
    // Setup a template and version in org-b
    const templateB = await migration.designTemplate.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        name: `Template B ${randomUUID()}`,
      },
    });

    const versionB = await migration.designTemplateVersion.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        templateId: templateB.id,
        version: 1,
        format: "SQUARE",
        spec: templateSpec,
        specHash: "hash-b",
        rendererVersion: "satori-0.33.4_sharp-0.35.4_v1",
      },
    });

    const batchB = await migration.renderBatch.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        templateVersionId: versionB.id,
        format: "SQUARE",
        sourceType: "POSTS_SELECTION",
        idempotencyKey: `idemp-b-${randomUUID()}`,
        requestHash: "hash-req-b",
        createdById: "admin-b",
        totalItems: 5,
        pendingItems: 5,
      },
    });

    try {
      // Actor from org-a cannot see batchB
      await asActor(runtime, "editor-a", async (tx) => {
        const found = await tx.renderBatch.findMany({
          where: { id: batchB.id },
        });
        expect(found).toEqual([]);
      });

      // Actor from org-a cannot create batch in org-b
      await expect(
        asActor(runtime, "editor-a", (tx) =>
          tx.renderBatch.create({
            data: {
              organizationId: "org-b",
              clientId: "client-b",
              templateVersionId: versionB.id,
              format: "SQUARE",
              sourceType: "POSTS_SELECTION",
              idempotencyKey: `idemp-cross-${randomUUID()}`,
              requestHash: "hash-cross",
              createdById: "editor-a",
              totalItems: 1,
              pendingItems: 1,
            },
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await migration.renderBatch.delete({ where: { id: batchB.id } });
      await migration.designTemplateVersion.delete({
        where: { id: versionB.id },
      });
      await migration.designTemplate.delete({ where: { id: templateB.id } });
    }
  });

  it("enforces RBAC permissions: EDITOR can create, CLIENT_VIEWER cannot", async () => {
    // Setup template and version in org-a
    const templateA = await migration.designTemplate.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        name: `Template A ${randomUUID()}`,
      },
    });

    const versionA = await migration.designTemplateVersion.create({
      data: {
        organizationId: "org-a",
        clientId: "client-a",
        templateId: templateA.id,
        version: 1,
        format: "SQUARE",
        spec: templateSpec,
        specHash: "hash-a",
        rendererVersion: "satori-0.33.4_sharp-0.35.4_v1",
      },
    });

    let createdBatchId: string | null = null;

    try {
      // 1. CLIENT_VIEWER cannot create
      await expect(
        asActor(runtime, "viewer-a", (tx) =>
          tx.renderBatch.create({
            data: {
              organizationId: "org-a",
              clientId: "client-a",
              templateVersionId: versionA.id,
              format: "SQUARE",
              sourceType: "POSTS_SELECTION",
              idempotencyKey: `idemp-viewer-${randomUUID()}`,
              requestHash: "hash-viewer",
              createdById: "viewer-a",
              totalItems: 2,
              pendingItems: 2,
            },
          }),
        ),
      ).rejects.toThrow();

      // 2. EDITOR can create
      const batch = await asActor(runtime, "editor-a", (tx) =>
        tx.renderBatch.create({
          data: {
            organizationId: "org-a",
            clientId: "client-a",
            templateVersionId: versionA.id,
            format: "SQUARE",
            sourceType: "POSTS_SELECTION",
            idempotencyKey: `idemp-editor-${randomUUID()}`,
            requestHash: "hash-editor",
            createdById: "editor-a",
            totalItems: 3,
            pendingItems: 3,
          },
        }),
      );

      expect(batch.id).toBeDefined();
      expect(batch.status).toBe("PENDING");
      expect(batch.totalItems).toBe(3);
      expect(batch.pendingItems).toBe(3);
      createdBatchId = batch.id;

      // 3. Create a RenderJob associated with the batch
      const job = await asActor(runtime, "editor-a", (tx) =>
        tx.renderJob.create({
          data: {
            organizationId: "org-a",
            clientId: "client-a",
            templateVersionId: versionA.id,
            batchId: batch.id,
            status: "PENDING",
            input: { title: "Card title in batch" },
            inputHash: "input-hash-test-batch",
            idempotencyKey: `job-key-${randomUUID()}`,
            createdById: "editor-a",
          },
        }),
      );

      expect(job.batchId).toBe(batch.id);

      // 4. Scope protection: attempting to alter immutable batch fields throws 42501
      await expect(
        asActor(
          runtime,
          "admin-a",
          (tx) =>
            tx.$executeRaw`UPDATE "RenderBatch" SET "totalItems" = 99 WHERE id = ${batch.id}`,
        ),
      ).rejects.toThrow();

      // 5. Counter protection: regular tenant users (even admin-a) CANNOT directly alter protected counters
      await expect(
        asActor(runtime, "admin-a", (tx) =>
          tx.renderBatch.update({
            where: { id: batch.id },
            data: {
              processingItems: 1,
              pendingItems: 2,
            },
          }),
        ),
      ).rejects.toThrow();

      // Only system:renderer can update counters and terminal timestamps
      await asActor(runtime, "admin-a", async (tx) => {
        await tx.$executeRaw`
          SELECT set_config('app.user_id', 'system:renderer', true),
                 set_config('app.renderer_org_id', 'org-a', true),
                 set_config('app.renderer_client_id', 'client-a', true)
        `;
        await tx.renderBatch.update({
          where: { id: batch.id },
          data: {
            status: "PROCESSING",
            processingItems: 1,
            pendingItems: 2,
          },
        });
      });

      const updated = await asActor(runtime, "viewer-a", (tx) =>
        tx.renderBatch.findUniqueOrThrow({ where: { id: batch.id } }),
      );
      expect(updated.status).toBe("PROCESSING");
      expect(updated.processingItems).toBe(1);
      expect(updated.pendingItems).toBe(2);

      // Clean up job before batch
      await migration.renderJob.delete({ where: { id: job.id } });
    } finally {
      if (createdBatchId) {
        await migration.renderBatch.delete({ where: { id: createdBatchId } });
      }
      await migration.designTemplateVersion.delete({
        where: { id: versionA.id },
      });
      await migration.designTemplate.delete({ where: { id: templateA.id } });
    }
  });
});
