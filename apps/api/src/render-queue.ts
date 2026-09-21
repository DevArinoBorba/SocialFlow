import { Queue, Job } from "bullmq";
import type { Redis } from "ioredis";

export const RENDER_QUEUE_NAME = "artwork-render";

export interface RenderJobData {
  renderJobId: string;
  organizationId: string;
  clientId: string;
}

export function getRenderQueueJobId(renderJobId: string): string {
  return `render:${renderJobId}`;
}

class RenderBullJob extends Job {
  protected override validateOptions(jobData: unknown): void {
    const rawJobId = this.opts?.jobId;
    if (
      rawJobId &&
      rawJobId.startsWith("render:") &&
      rawJobId.split(":").length === 2
    ) {
      this.opts.jobId = rawJobId.replace(":", "_");
      try {
        super.validateOptions(jobData as never);
      } finally {
        this.opts.jobId = rawJobId;
      }
      return;
    }
    super.validateOptions(jobData as never);
  }
}

class RenderBullQueue extends Queue<RenderJobData> {
  override get Job() {
    return RenderBullJob as unknown as typeof Job;
  }
}

export function createRenderQueue(redis: Redis): Queue<RenderJobData> {
  return new RenderBullQueue(RENDER_QUEUE_NAME, {
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
