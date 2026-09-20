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

let queueInstance: Queue<ScheduleJobData> | null = null;

export function getScheduleQueue(redis: Redis): Queue<ScheduleJobData> {
  if (!queueInstance) {
    queueInstance = new Queue<ScheduleJobData>(SCHEDULE_QUEUE_NAME, {
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
  return queueInstance;
}
