import { createServer } from "node:http";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import { readConfig, bounded } from "@socialflow/config";
import { createDatabase, asActor, assertRuntimeRole } from "@socialflow/db";
const config = readConfig(process.env);
const db = createDatabase(config.DATABASE_URL);
await assertRuntimeRole(db);
const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  connectTimeout: 2500,
});
redis.on("error", () =>
  console.error(JSON.stringify({ event: "worker_redis_unavailable" })),
);
const input = z.strictObject({
  userId: z.string().min(1),
  organizationId: z.string().min(1),
});
const worker = new Worker(
  "diagnostics",
  async (job) => {
    if (job.name !== "diagnostic") throw new Error("Unsupported job");
    const data = input.parse(job.data);
    await asActor(db, data.userId, async (tx) => {
      const membership = await tx.membership.findFirst({
        where: {
          userId: data.userId,
          organizationId: data.organizationId,
          active: true,
          role: { in: ["OWNER", "ADMIN"] },
          organization: { active: true },
        },
      });
      if (!membership) throw new Error("Authorization revoked");
      await tx.$queryRaw`SELECT 1`;
    });
    console.info(
      JSON.stringify({ event: "diagnostic_completed", jobId: job.id }),
    );
    return { status: "ok" };
  },
  { connection: redis, concurrency: 2 },
);
worker.on("error", () =>
  console.error(JSON.stringify({ event: "worker_error" })),
);
worker.on("failed", (job) =>
  console.error(JSON.stringify({ event: "diagnostic_failed", jobId: job?.id })),
);
let stopping = false;
const server = createServer(async (req, res) => {
  if (req.url !== "/health/ready" && req.url !== "/health/live") {
    res.writeHead(404).end();
    return;
  }
  try {
    if (stopping) throw new Error("Stopping");
    if (req.url === "/health/ready")
      await bounded(
        Promise.all([
          db.$queryRaw`SELECT 1`,
          redis.ping(),
          worker.waitUntilReady(),
        ]),
      );
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end('{"status":"ok"}');
  } catch {
    res.writeHead(503).end('{"status":"unavailable"}');
  }
});
server.listen(3002, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 25000);
    deadline.unref();
    server.close();
    void worker.close().then(async () => {
      redis.disconnect();
      await db.$disconnect();
      clearTimeout(deadline);
      process.exit(0);
    });
  });
