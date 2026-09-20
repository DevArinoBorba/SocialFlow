import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const SCHEDULE_QUEUE_NAME = "publication-schedule";

export interface ScheduleJobData {
  scheduleId: string;
  version: number;
  organizationId: string;
  clientId: string;
  postId: string;
}

export function getScheduleJobId(scheduleId: string, version: number): string {
  return `sched:${scheduleId}:v${version}`;
}

export function createScheduleQueue(redis: Redis): Queue<ScheduleJobData> {
  return new Queue<ScheduleJobData>(SCHEDULE_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 500,
      attempts: 4,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
    },
  });
}

export async function closeScheduleQueue(
  queue: Queue<ScheduleJobData>,
): Promise<void> {
  try {
    await queue.close();
  } catch {
    // Graceful close tolerance
  }
}

/**
 * Creates a schedule queue instance bound to the provided Redis connection.
 * @deprecated Use createScheduleQueue with explicit lifecycle management.
 */
export function getScheduleQueue(redis: Redis): Queue<ScheduleJobData> {
  return createScheduleQueue(redis);
}
