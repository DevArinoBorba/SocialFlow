import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export { sanitizeErrorMessage } from "./log-sanitizer.js";
export const RENDER_QUEUE_NAME = "artwork-render";

export interface RenderJobData {
  renderJobId: string;
  organizationId: string;
  clientId: string;
}

export function getRenderQueueJobId(renderJobId: string): string {
  return `render-${renderJobId}`;
}

export function createRenderQueue(redis: Redis): Queue<RenderJobData> {
  return new Queue<RenderJobData>(RENDER_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 500,
      attempts: 4,
      backoff: { type: "exponential", delay: 2000 },
    },
  });
}

export async function closeRenderQueue(
  queue: Queue<RenderJobData>,
): Promise<void> {
  try {
    await queue.close();
  } catch {
    // Graceful shutdown must continue when Redis is already unavailable.
  }
}
