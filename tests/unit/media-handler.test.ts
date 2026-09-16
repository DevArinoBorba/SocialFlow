import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { Prisma } from "@socialflow/db";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMedia, type Scope } from "../../apps/api/src/media.js";

const requireApi = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
);
const express = requireApi("express");
const secret = "secret-storage-credential";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const png = await sharp({
  create: { width: 2, height: 2, channels: 3, background: "red" },
})
  .png()
  .toBuffer();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Only external dependencies are replaced. HTTP parsing, image validation,
// access checks, failure handling and log construction use registerMedia itself.
async function upload(
  options: {
    storageFails?: boolean;
    revoke?: boolean;
    commitFails?: boolean;
    recoveryCommitFails?: boolean;
    correlation?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  let status = "pending";
  let actions: string[] = [];
  let membershipActive = true;
  let scopes = 0;
  const scoped: Scope = async (_req, _org, fn) => {
    scopes++;
    let nextStatus = status;
    const nextActions = [...actions];
    const tx = {
      client: { findFirst: async () => ({ id: "client" }) },
      membership: {
        findFirst: async () => (membershipActive ? { role: "EDITOR" } : null),
      },
      mediaAsset: {
        findFirst: async () => ({ id: "asset", status: nextStatus }),
        findFirstOrThrow: async () => ({
          id: "asset",
          storageKey: "media/org/client/asset",
          status: nextStatus,
        }),
        updateMany: async ({ data }: { data: { status: string } }) => {
          if (data.status === "ready" && options.commitFails)
            throw new Error(secret);
          nextStatus = data.status;
          return { count: 1 };
        },
      },
      auditLog: {
        create: async ({ data }: { data: { action: string } }) => {
          nextActions.push(data.action);
        },
      },
    };
    const result = await fn(
      tx as unknown as Prisma.TransactionClient,
      "editor",
      false,
    );
    // Model commit rejection after the callback succeeds, without persisting it.
    if (nextStatus === "failed" && options.recoveryCommitFails)
      throw new Error(secret);
    status = nextStatus;
    actions = nextActions;
    return result;
  };
  const put = vi.fn(async () => {
    if (options.revoke) membershipActive = false;
    if (options.storageFails) throw new Error(secret);
  });
  const app = express();
  registerMedia(app, scoped, {
    storage: { put, get: async () => Buffer.alloc(0), close() {} },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/organizations/org/clients/client/media/asset/content`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-correlation-id": options.correlation ?? "client-trace",
          ...options.headers,
        },
        body: new Uint8Array(png),
      },
    );
    const body = await response.json();
    const logs = [...errors.mock.calls, ...warnings.mock.calls].map(([line]) =>
      JSON.parse(String(line)),
    );
    expect(JSON.stringify({ logs, body })).not.toContain(secret);
    return { code: response.status, body, status, actions, scopes, put, logs };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error?: Error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("item 6 real HTTP handler with isolated dependencies", () => {
  it.each(["production", "development", "test"])(
    "ignores all legacy failure headers in %s",
    async (env) => {
      vi.stubEnv("NODE_ENV", env);
      const result = await upload({
        headers: {
          "x-test-fail-storage": "true",
          "x-test-fail-commit": "true",
          "x-test-fail-recovery": "true",
          "x-test-revoke-membership": "true",
        },
      });
      expect(result.code).toBe(201);
      expect(result.status).toBe("ready");
      expect(result.put).toHaveBeenCalledOnce();
      expect(result.actions).toEqual(["media.upload_started", "media.created"]);
      expect(result.logs).toEqual([]);
    },
  );

  it.each(["storage_put", "database_commit"])(
    "recovers %s failures through the real catch",
    async (stage) => {
      const result = await upload({
        storageFails: stage === "storage_put",
        commitFails: stage === "database_commit",
      });
      expect(result.code).toBe(503);
      expect(result.status).toBe("failed");
      expect(result.actions).toEqual([
        "media.upload_started",
        "media.upload_failed",
      ]);
      expect(
        result.logs.filter(
          (log) => log.event === "media_reconciliation_needed",
        ),
      ).toEqual([]);
      expect(result.logs).toContainEqual(
        expect.objectContaining({
          event: "media_upload_failed",
          stage,
          correlationId: expect.stringMatching(uuid),
          clientCorrelationId: "client-trace",
        }),
      );
    },
  );

  it("preserves access denial when membership disappears after storage write", async () => {
    const result = await upload({ revoke: true });
    expect(result.code).toBe(404);
    expect(result.body).toEqual({ message: "Cliente não encontrado." });
    expect(result.scopes).toBe(4);
    expect(result.status).toBe("uploading");
    expect(result.actions).toEqual(["media.upload_started"]);
    expect(result.logs.map((log) => log.event)).toEqual([
      "media_upload_failed",
      "media_reconciliation_needed",
    ]);
  });

  it.each(["storage_put", "database_commit"])(
    "logs reconciliation if recovery transaction commit fails after %s",
    async (stage) => {
      const result = await upload({
        storageFails: stage === "storage_put",
        commitFails: stage === "database_commit",
        recoveryCommitFails: true,
        correlation: "x".repeat(65),
      });
      expect(result.code).toBe(503);
      expect(result.status).toBe("uploading");
      expect(result.actions).toEqual(["media.upload_started"]);
      const failure = result.logs.find(
        (log) => log.event === "media_upload_failed",
      );
      const reconciliation = result.logs.find(
        (log) => log.event === "media_reconciliation_needed",
      );
      expect(reconciliation).toEqual(
        expect.objectContaining({
          stage,
          correlationId: failure.correlationId,
          status: "uploading",
          storageKey: "media/org/client/asset",
        }),
      );
      expect(failure.correlationId).toMatch(uuid);
      expect(failure).not.toHaveProperty("clientCorrelationId");
      expect(reconciliation).not.toHaveProperty("clientCorrelationId");
    },
  );
});
