import { createServer } from "node:http";
import { Redis } from "ioredis";
import { readConfig, bounded } from "@socialflow/config";
import { createDatabase, assertRuntimeRole } from "@socialflow/db";
import { mediaStorage } from "@socialflow/api/media-storage.js";
import {
  createRendererWorker,
  runRendererStartupReconciliation,
  RendererReconciler,
  sanitizeErrorMessage,
} from "./renderer-worker.js";

const config = readConfig(process.env);
const db = createDatabase(config.DATABASE_URL);
await assertRuntimeRole(db);

const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  connectTimeout: 2500,
});
redis.on("error", () =>
  console.error(JSON.stringify({ event: "renderer_redis_unavailable" })),
);

const storage = mediaStorage(process.env);
if (!storage) {
  console.error(
    JSON.stringify({
      event: "renderer_storage_unconfigured",
      message: "Media storage is required for the renderer worker process",
    }),
  );
  process.exit(1);
}

// 1. Reconciliação de inicialização do renderer
try {
  const reconResult = await runRendererStartupReconciliation(db, redis);
  console.info(
    JSON.stringify({
      event: "renderer_startup_reconciliation_completed",
      ...reconResult,
    }),
  );
} catch (reconErr) {
  console.error(
    JSON.stringify({
      event: "renderer_startup_reconciliation_failed",
      error: sanitizeErrorMessage(
        reconErr instanceof Error ? reconErr.message : String(reconErr),
      ),
    }),
  );
}

// 2. Inicia reconciliação periódica segura
const reconcileIntervalMs =
  Number(process.env.RENDERER_RECONCILE_INTERVAL_MS) || 60_000;
const reconciler = new RendererReconciler(db, redis, {
  intervalMs: reconcileIntervalMs,
});
reconciler.start();

// 3. Inicia o worker com concorrência inicial de 1 consumindo exclusivamente artwork-render
const renderWorker = createRendererWorker(db, redis, storage, {
  concurrency: 1,
});

let stopping = false;
const server = createServer(async (req, res) => {
  if (req.url !== "/health/ready" && req.url !== "/health/live") {
    res.writeHead(404).end();
    return;
  }
  try {
    if (stopping) throw new Error("Stopping");
    if (req.url === "/health/ready") {
      if (!storage) throw new Error("Storage unavailable");
      const storageReady = storage.checkReadiness
        ? await storage.checkReadiness()
        : true;
      if (!storageReady) throw new Error("Storage unreachable");
      await bounded(
        Promise.all([
          db.$queryRaw`SELECT 1`,
          redis.ping(),
          renderWorker.waitUntilReady(),
        ]),
      );
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end('{"status":"ok"}');
  } catch {
    res.writeHead(503).end('{"status":"unavailable"}');
  }
});

const PORT = 3003;
server.listen(PORT, "0.0.0.0", () => {
  console.info(
    JSON.stringify({
      event: "renderer_worker_started",
      port: PORT,
      concurrency: 1,
    }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    reconciler.stop();
    const deadline = setTimeout(() => process.exit(1), 25000);
    deadline.unref();
    server.close();
    void Promise.all([renderWorker.close()]).then(async () => {
      storage.close();
      redis.disconnect();
      await db.$disconnect();
      clearTimeout(deadline);
      process.exit(0);
    });
  });
}
