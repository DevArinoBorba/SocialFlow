import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asActor,
  asRendererActor,
  assertRuntimeRole,
  createDatabase,
} from "../../packages/db/src/index.js";

const runtime = createDatabase(process.env.DATABASE_URL!);
const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);

const templateSpec = {
  schemaVersion: 1,
  format: "PORTRAIT",
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

type Fixture = {
  templateId: string;
  versionId: string;
  backgroundId: string;
  logoId: string;
  jobId: string;
};

async function createFixture(
  organizationId = "org-a",
  clientId = "client-a",
): Promise<Fixture> {
  const suffix = randomUUID();
  const template = await migration.designTemplate.create({
    data: { organizationId, clientId, name: `Renderer ${suffix}` },
  });
  const version = await migration.designTemplateVersion.create({
    data: {
      organizationId,
      clientId,
      templateId: template.id,
      version: 1,
      format: "PORTRAIT",
      spec: templateSpec,
      specHash: "a".repeat(64),
      rendererVersion: "renderer-test-v1",
    },
  });
  const backgroundId = randomUUID();
  const logoId = randomUUID();
  for (const [id, name] of [
    [backgroundId, "Background"],
    [logoId, "Logo"],
  ] as const) {
    await migration.mediaAsset.create({
      data: {
        id,
        organizationId,
        clientId,
        name,
        storageKey: `media/${organizationId}/${clientId}/${id}`,
        status: "ready",
        mimeType: "image/png",
        byteSize: 100,
        width: 10,
        height: 10,
        sha256: "b".repeat(64),
      },
    });
  }
  const job = await migration.renderJob.create({
    data: {
      organizationId,
      clientId,
      templateVersionId: version.id,
      backgroundMediaAssetId: backgroundId,
      logoMediaAssetId: logoId,
      input: { title: "RLS renderer" },
      inputHash: "c".repeat(64),
      idempotencyKey: `renderer-${suffix}`,
      createdById: organizationId === "org-a" ? "editor-a" : "admin-b",
    },
  });
  return {
    templateId: template.id,
    versionId: version.id,
    backgroundId,
    logoId,
    jobId: job.id,
  };
}

async function cleanupFixture(fixture: Fixture) {
  await migration.auditLog.deleteMany({ where: { entityId: fixture.jobId } });
  await migration.renderJob.deleteMany({ where: { id: fixture.jobId } });
  await migration.mediaAsset.deleteMany({
    where: {
      id: { in: [fixture.backgroundId, fixture.logoId, fixture.jobId] },
    },
  });
  await migration.designTemplateVersion.deleteMany({
    where: { id: fixture.versionId },
  });
  await migration.designTemplate.deleteMany({
    where: { id: fixture.templateId },
  });
}

beforeAll(async () => {
  await runtime.$connect();
  await migration.$connect();
  await assertRuntimeRole(runtime);
});

afterAll(async () => {
  await runtime.$disconnect();
  await migration.$disconnect();
});

describe("renderer system actor RLS", () => {
  it("isolates renderer reads to templates, jobs and ready media in its exact tenant", async () => {
    const own = await createFixture();
    const other = await createFixture("org-b", "client-b");
    const pendingId = randomUUID();
    await migration.mediaAsset.create({
      data: {
        id: pendingId,
        organizationId: "org-a",
        clientId: "client-a",
        name: "Pending",
        storageKey: `media/org-a/client-a/${pendingId}`,
      },
    });
    try {
      await asRendererActor(
        runtime,
        { organizationId: "org-a", clientId: "client-a" },
        async (tx) => {
          expect(
            await tx.designTemplate.count({ where: { id: own.templateId } }),
          ).toBe(1);
          expect(
            await tx.designTemplateVersion.count({
              where: { id: own.versionId },
            }),
          ).toBe(1);
          expect(await tx.renderJob.count({ where: { id: own.jobId } })).toBe(
            1,
          );
          expect(
            await tx.mediaAsset.count({ where: { id: own.backgroundId } }),
          ).toBe(1);
          expect(await tx.mediaAsset.count({ where: { id: pendingId } })).toBe(
            0,
          );
          expect(await tx.renderJob.count({ where: { id: other.jobId } })).toBe(
            0,
          );
          expect(await tx.post.count()).toBe(0);
          expect(await tx.publicationSchedule.count()).toBe(0);
          expect(await tx.oAuthCredential.count()).toBe(0);
          expect(await tx.socialAccount.count()).toBe(0);
        },
      );
    } finally {
      await migration.mediaAsset.deleteMany({ where: { id: pendingId } });
      await cleanupFixture(own);
      await cleanupFixture(other);
    }
  });

  it("validates background and logo referential integrity and rejects pending, archived or cross-tenant media", async () => {
    const fixture = await createFixture();
    const other = await createFixture("org-b", "client-b");
    const pendingId = randomUUID();
    const archivedId = randomUUID();

    await migration.mediaAsset.create({
      data: {
        id: pendingId,
        organizationId: "org-a",
        clientId: "client-a",
        name: "Pending Media",
        storageKey: `media/org-a/client-a/${pendingId}`,
        status: "pending",
      },
    });
    await migration.mediaAsset.create({
      data: {
        id: archivedId,
        organizationId: "org-a",
        clientId: "client-a",
        name: "Archived Media",
        storageKey: `media/org-a/client-a/${archivedId}`,
        status: "ready",
        archived: true,
      },
    });

    try {
      // Rejects pending background media
      await expect(
        asActor(runtime, "editor-a", (tx) =>
          tx.renderJob.create({
            data: {
              organizationId: "org-a",
              clientId: "client-a",
              templateVersionId: fixture.versionId,
              backgroundMediaAssetId: pendingId,
              input: { title: "Test pending" },
              inputHash: "d".repeat(64),
              idempotencyKey: `render-pending-${randomUUID()}`,
              createdById: "editor-a",
            },
          }),
        ),
      ).rejects.toThrow();

      // Rejects archived background media
      await expect(
        asActor(runtime, "editor-a", (tx) =>
          tx.renderJob.create({
            data: {
              organizationId: "org-a",
              clientId: "client-a",
              templateVersionId: fixture.versionId,
              backgroundMediaAssetId: archivedId,
              input: { title: "Test archived" },
              inputHash: "d".repeat(64),
              idempotencyKey: `render-archived-${randomUUID()}`,
              createdById: "editor-a",
            },
          }),
        ),
      ).rejects.toThrow();

      // Rejects pending logo media
      await expect(
        asActor(runtime, "editor-a", (tx) =>
          tx.renderJob.create({
            data: {
              organizationId: "org-a",
              clientId: "client-a",
              templateVersionId: fixture.versionId,
              logoMediaAssetId: pendingId,
              input: { title: "Test pending logo" },
              inputHash: "d".repeat(64),
              idempotencyKey: `render-pending-logo-${randomUUID()}`,
              createdById: "editor-a",
            },
          }),
        ),
      ).rejects.toThrow();

      // Rejects cross-tenant media (foreign key composite check)
      await expect(
        asActor(runtime, "editor-a", (tx) =>
          tx.renderJob.create({
            data: {
              organizationId: "org-a",
              clientId: "client-a",
              templateVersionId: fixture.versionId,
              backgroundMediaAssetId: other.backgroundId,
              input: { title: "Test cross tenant" },
              inputHash: "d".repeat(64),
              idempotencyKey: `render-cross-${randomUUID()}`,
              createdById: "editor-a",
            },
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await migration.mediaAsset.deleteMany({
        where: { id: { in: [pendingId, archivedId] } },
      });
      await cleanupFixture(fixture);
      await cleanupFixture(other);
    }
  });

  it("reserves operational RenderJob fields for system:renderer and enforces immutability", async () => {
    const fixture = await createFixture();
    try {
      // Common user cannot update operational status or tokens
      await expect(
        asActor(runtime, "editor-a", (tx) =>
          tx.renderJob.update({
            where: { id: fixture.jobId },
            data: { status: "PROCESSING" },
          }),
        ),
      ).rejects.toThrow();

      await expect(
        asActor(runtime, "editor-a", (tx) =>
          tx.renderJob.update({
            where: { id: fixture.jobId },
            data: { queueJobId: `render-${fixture.jobId}` },
          }),
        ),
      ).rejects.toThrow();

      await expect(
        asActor(runtime, "editor-a", (tx) =>
          tx.renderJob.update({
            where: { id: fixture.jobId },
            data: { executionToken: randomUUID() },
          }),
        ),
      ).rejects.toThrow();

      // Scoped renderer CAN update operational fields
      await asRendererActor(
        runtime,
        { organizationId: "org-a", clientId: "client-a" },
        async (tx) => {
          const updated = await tx.renderJob.update({
            where: { id: fixture.jobId },
            data: {
              status: "PROCESSING",
              queueJobId: `render-${fixture.jobId}`,
              executionToken: randomUUID(),
              attemptNumber: { increment: 1 },
              leaseExpiresAt: new Date(Date.now() + 60_000),
            },
          });
          expect(updated.status).toBe("PROCESSING");
          expect(updated.queueJobId).toBe(`render-${fixture.jobId}`);
          expect(updated.attemptNumber).toBe(1);
        },
      );

      // Immutable fields are rejected by protect_render_job_scope trigger
      await expect(
        asRendererActor(
          runtime,
          { organizationId: "org-a", clientId: "client-a" },
          (tx) =>
            tx.renderJob.update({
              where: { id: fixture.jobId },
              data: { inputHash: "d".repeat(64) },
            }),
        ),
      ).rejects.toThrow();

      await expect(
        asRendererActor(
          runtime,
          { organizationId: "org-a", clientId: "client-a" },
          (tx) =>
            tx.renderJob.update({
              where: { id: fixture.jobId },
              data: { idempotencyKey: "new-key" },
            }),
        ),
      ).rejects.toThrow();
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("manages lease acquisition and recovery correctly", async () => {
    const fixture = await createFixture();
    const token1 = randomUUID();
    const token2 = randomUUID();
    const token3 = randomUUID();

    try {
      // 1. First acquisition succeeds on PENDING job
      await asRendererActor(
        runtime,
        { organizationId: "org-a", clientId: "client-a" },
        async (tx) => {
          const count = await tx.$executeRaw`
            UPDATE "RenderJob"
            SET status = 'PROCESSING',
                "executionToken" = ${token1},
                "leaseExpiresAt" = ${new Date(Date.now() + 60_000)},
                "attemptNumber" = "attemptNumber" + 1
            WHERE id = ${fixture.jobId}
              AND (status = 'PENDING' OR (status = 'PROCESSING' AND "leaseExpiresAt" < CURRENT_TIMESTAMP))
          `;
          expect(count).toBe(1);
        },
      );

      // 2. Second concurrent acquisition fails while lease is active
      await asRendererActor(
        runtime,
        { organizationId: "org-a", clientId: "client-a" },
        async (tx) => {
          const count = await tx.$executeRaw`
            UPDATE "RenderJob"
            SET status = 'PROCESSING',
                "executionToken" = ${token2},
                "leaseExpiresAt" = ${new Date(Date.now() + 60_000)},
                "attemptNumber" = "attemptNumber" + 1
            WHERE id = ${fixture.jobId}
              AND (status = 'PENDING' OR (status = 'PROCESSING' AND "leaseExpiresAt" < CURRENT_TIMESTAMP))
          `;
          expect(count).toBe(0);
        },
      );

      // 3. Expire the lease in database
      await migration.renderJob.update({
        where: { id: fixture.jobId },
        data: { leaseExpiresAt: new Date(Date.now() - 10_000) },
      });

      // 4. Recovery acquisition succeeds when lease is expired
      await asRendererActor(
        runtime,
        { organizationId: "org-a", clientId: "client-a" },
        async (tx) => {
          const count = await tx.$executeRaw`
            UPDATE "RenderJob"
            SET status = 'PROCESSING',
                "executionToken" = ${token3},
                "leaseExpiresAt" = ${new Date(Date.now() + 60_000)},
                "attemptNumber" = "attemptNumber" + 1
            WHERE id = ${fixture.jobId}
              AND (status = 'PENDING' OR (status = 'PROCESSING' AND "leaseExpiresAt" < CURRENT_TIMESTAMP))
          `;
          expect(count).toBe(1);
        },
      );

      const job = await migration.renderJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      });
      expect(job.executionToken).toBe(token3);
      expect(job.attemptNumber).toBe(2);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("allows only the deterministic output MediaAsset to be created and finalized", async () => {
    const fixture = await createFixture();
    const arbitraryId = randomUUID();
    try {
      // Arbitrary MediaAsset creation is rejected
      await expect(
        asRendererActor(
          runtime,
          { organizationId: "org-a", clientId: "client-a" },
          (tx) =>
            tx.mediaAsset.create({
              data: {
                id: arbitraryId,
                organizationId: "org-a",
                clientId: "client-a",
                name: "Arbitrary",
                storageKey: `media/org-a/client-a/${arbitraryId}`,
              },
            }),
        ),
      ).rejects.toThrow();

      // Deterministic MediaAsset creation and finalization
      await asRendererActor(
        runtime,
        { organizationId: "org-a", clientId: "client-a" },
        async (tx) => {
          await tx.mediaAsset.create({
            data: {
              id: fixture.jobId,
              organizationId: "org-a",
              clientId: "client-a",
              name: "Rendered artwork",
              storageKey: `media/org-a/client-a/${fixture.jobId}`,
            },
          });
          await tx.mediaAsset.update({
            where: { id: fixture.jobId },
            data: {
              status: "ready",
              mimeType: "image/png",
              byteSize: 1024,
              width: 1080,
              height: 1350,
              sha256: "e".repeat(64),
            },
          });
          await tx.renderJob.update({
            where: { id: fixture.jobId },
            data: {
              outputMediaAssetId: fixture.jobId,
              status: "COMPLETED",
              completedAt: new Date(),
              leaseExpiresAt: null,
              executionToken: null,
            },
          });
          expect(
            await tx.$queryRaw<Array<{ actor: string | null }>>`
              SELECT current_actor() AS actor
            `,
          ).toEqual([{ actor: "system:renderer" }]);
          expect(
            await tx.renderJob.count({ where: { id: fixture.jobId } }),
          ).toBe(1);

          // Once finalized, creating a duplicate MediaAsset for the same job is rejected
          await expect(
            tx.mediaAsset.create({
              data: {
                id: randomUUID(),
                organizationId: "org-a",
                clientId: "client-a",
                name: "Duplicate attempt",
                storageKey: `media/org-a/client-a/${randomUUID()}`,
              },
            }),
          ).rejects.toThrow();
        },
      );
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("permits all renderer lifecycle audit actions and rejects unauthorized actions or tenants", async () => {
    const fixture = await createFixture();
    const other = await createFixture("org-b", "client-b");

    try {
      await asRendererActor(
        runtime,
        { organizationId: "org-a", clientId: "client-a" },
        async (tx) => {
          // All 4 permitted audit actions succeed
          for (const action of [
            "render.started",
            "render.recovered",
            "render.failed",
            "render.completed",
          ] as const) {
            const audit = await tx.auditLog.create({
              data: {
                organizationId: "org-a",
                actorUserId: "system:renderer",
                action,
                entityId: fixture.jobId,
              },
            });
            expect(audit.action).toBe(action);
          }

          // Disallowed audit action is rejected
          await expect(
            tx.auditLog.create({
              data: {
                organizationId: "org-a",
                actorUserId: "system:renderer",
                action: "post.created",
                entityId: fixture.jobId,
              },
            }),
          ).rejects.toThrow();

          await expect(
            tx.auditLog.create({
              data: {
                organizationId: "org-a",
                actorUserId: "system:renderer",
                action: "render.deleted",
                entityId: fixture.jobId,
              },
            }),
          ).rejects.toThrow();

          // Audit for another tenant's job is rejected
          await expect(
            tx.auditLog.create({
              data: {
                organizationId: "org-a",
                actorUserId: "system:renderer",
                action: "render.completed",
                entityId: other.jobId,
              },
            }),
          ).rejects.toThrow();
        },
      );
    } finally {
      await cleanupFixture(fixture);
      await cleanupFixture(other);
    }
  });

  it("discovers only pending jobs and processing jobs with expired leases", async () => {
    const pending = await createFixture();
    const expired = await createFixture();
    const active = await createFixture();
    const completed = await createFixture();
    const failed = await createFixture();

    try {
      await migration.renderJob.update({
        where: { id: expired.jobId },
        data: {
          status: "PROCESSING",
          leaseExpiresAt: new Date(Date.now() - 60_000),
        },
      });
      await migration.renderJob.update({
        where: { id: active.jobId },
        data: {
          status: "PROCESSING",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      await migration.renderJob.update({
        where: { id: completed.jobId },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      await migration.renderJob.update({
        where: { id: failed.jobId },
        data: { status: "FAILED", errorCode: "RENDER_ERROR" },
      });

      const rows = await runtime.$queryRaw<
        { renderJobId: string; organizationId: string; clientId: string }[]
      >`
        SELECT * FROM discover_reconcilable_render_jobs()
      `;
      const ids = new Set(rows.map((row) => row.renderJobId));
      expect(ids.has(pending.jobId)).toBe(true);
      expect(ids.has(expired.jobId)).toBe(true);
      expect(ids.has(active.jobId)).toBe(false);
      expect(ids.has(completed.jobId)).toBe(false);
      expect(ids.has(failed.jobId)).toBe(false);
    } finally {
      await cleanupFixture(pending);
      await cleanupFixture(expired);
      await cleanupFixture(active);
      await cleanupFixture(completed);
      await cleanupFixture(failed);
    }
  });
});
