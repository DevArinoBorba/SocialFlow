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

beforeAll(async () => {
  await runtime.$connect();
  await assertRuntimeRole(runtime);
});

afterAll(async () => {
  await runtime.$disconnect();
  await migration.$disconnect();
});

describe("render foundation RLS and idempotency", () => {
  it.each(["DesignTemplate", "DesignTemplateVersion", "RenderJob"])(
    "forces RLS on %s",
    async (table) => {
      const rows = await migration.$queryRawUnsafe<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"${table}"'::regclass`,
      );
      expect(rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    },
  );

  it("isolates templates across organizations", async () => {
    const other = await migration.designTemplate.create({
      data: {
        organizationId: "org-b",
        clientId: "client-b",
        name: `Template B ${randomUUID()}`,
      },
    });
    try {
      await asActor(runtime, "editor-a", async (tx) => {
        expect(
          await tx.designTemplate.findMany({ where: { id: other.id } }),
        ).toEqual([]);
      });
      await expect(
        asActor(runtime, "editor-a", (tx) =>
          tx.designTemplate.create({
            data: {
              organizationId: "org-b",
              clientId: "client-b",
              name: "Cross tenant",
            },
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await migration.designTemplate.delete({ where: { id: other.id } });
    }
  });

  it("keeps template versions immutable and render jobs idempotent", async () => {
    const ids: { template?: string; version?: string; job?: string } = {};
    try {
      await asActor(runtime, "editor-a", async (tx) => {
        const template = await tx.designTemplate.create({
          data: {
            organizationId: "org-a",
            clientId: "client-a",
            name: `Template ${randomUUID()}`,
          },
        });
        ids.template = template.id;
        const version = await tx.designTemplateVersion.create({
          data: {
            organizationId: "org-a",
            clientId: "client-a",
            templateId: template.id,
            version: 1,
            format: "PORTRAIT",
            spec: templateSpec,
            specHash: "a".repeat(64),
            rendererVersion: "satori-0.33.4_sharp-0.35.4_v1",
          },
        });
        ids.version = version.id;
        const job = await tx.renderJob.create({
          data: {
            organizationId: "org-a",
            clientId: "client-a",
            templateVersionId: version.id,
            input: { title: "Teste" },
            inputHash: "b".repeat(64),
            idempotencyKey: `render-${randomUUID()}`,
            createdById: "editor-a",
          },
        });
        ids.job = job.id;
      });

      await expect(
        asActor(runtime, "editor-a", (tx) =>
          tx.renderJob.update({
            where: { id: ids.job! },
            data: { inputHash: "c".repeat(64) },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        asActor(runtime, "editor-a", (tx) =>
          tx.designTemplateVersion.update({
            where: { id: ids.version! },
            data: { rendererVersion: "changed" },
          }),
        ),
      ).rejects.toThrow();

      const original = await migration.renderJob.findUniqueOrThrow({
        where: { id: ids.job! },
      });
      await expect(
        migration.renderJob.create({
          data: {
            organizationId: original.organizationId,
            clientId: original.clientId,
            templateVersionId: original.templateVersionId,
            input: original.input!,
            inputHash: original.inputHash,
            idempotencyKey: original.idempotencyKey,
            createdById: original.createdById,
          },
        }),
      ).rejects.toThrow();
    } finally {
      if (ids.job)
        await migration.renderJob.deleteMany({ where: { id: ids.job } });
      if (ids.version)
        await migration.designTemplateVersion.deleteMany({
          where: { id: ids.version },
        });
      if (ids.template)
        await migration.designTemplate.deleteMany({
          where: { id: ids.template },
        });
    }
  });
});
