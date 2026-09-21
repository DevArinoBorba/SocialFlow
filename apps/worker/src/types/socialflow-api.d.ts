declare module "@socialflow/api/scheduler-queue.js" {
  import type { Queue } from "bullmq";
  import type { Redis } from "ioredis";

  export const SCHEDULE_QUEUE_NAME = "publication-schedule";

  export interface ScheduleJobData {
    scheduleId: string;
    version: number;
    organizationId: string;
    clientId: string;
    postId: string;
  }

  export function getScheduleJobId(scheduleId: string, version: number): string;
  export function createScheduleQueue(redis: Redis): Queue<ScheduleJobData>;
  export function closeScheduleQueue(
    queue: Queue<ScheduleJobData>,
  ): Promise<void>;
  export function getScheduleQueue(redis: Redis): Queue<ScheduleJobData>;
}

declare module "@socialflow/api/render-queue.js" {
  import type { Queue } from "bullmq";
  import type { Redis } from "ioredis";

  export const RENDER_QUEUE_NAME = "artwork-render";

  export interface RenderJobData {
    renderJobId: string;
    organizationId: string;
    clientId: string;
  }

  export function getRenderQueueJobId(renderJobId: string): string;
  export function createRenderQueue(redis: Redis): Queue<RenderJobData>;
  export function closeRenderQueue(queue: Queue<RenderJobData>): Promise<void>;
}

declare module "@socialflow/api/media-storage.js" {
  export const MAX_IMAGE_BYTES: number;

  export interface ValidatedImage {
    data: Buffer;
    mimeType: string;
    byteSize: number;
    width: number;
    height: number;
    sha256: string;
  }

  export function validateImage(input: Buffer): Promise<ValidatedImage>;

  export interface MediaStorage {
    put(key: string, data: Buffer, mimeType: string): Promise<void>;
    get(key: string): Promise<Buffer>;
    close(): void;
  }

  export function mediaStorage(env: NodeJS.ProcessEnv): MediaStorage | null;
}

declare module "@socialflow/api/meta-publisher.js" {
  export interface MetaPublisherOptions {
    graphBaseUrl?: string;
    fetchFn?: typeof fetch;
  }

  export interface FacebookPostPayload {
    pageId: string;
    accessToken: string;
    caption: string;
    imageUrl?: string;
  }

  export interface InstagramPostPayload {
    igUserId: string;
    accessToken: string;
    caption: string;
    imageUrl: string;
  }

  export interface InstagramOptions {
    existingContainerId?: string | null;
    onContainerCreated?: (containerId: string) => Promise<void>;
  }

  export interface PublishResult {
    remoteMediaId: string;
    remotePermalink: string | null;
    creationContainerId?: string;
  }

  export class MetaPublisherAdapter {
    constructor(options?: MetaPublisherOptions);
    publishFacebook(payload: FacebookPostPayload): Promise<PublishResult>;
    publishInstagram(
      payload: InstagramPostPayload,
      options?: InstagramOptions,
    ): Promise<PublishResult>;
  }
}

declare module "@socialflow/api/publication-service.js" {
  import type { Redis } from "ioredis";
  import type { Prisma } from "@socialflow/db";
  import type { PublicationAttemptDto } from "@socialflow/contracts";
  import type { MetaPublisherAdapter } from "@socialflow/api/meta-publisher.js";

  export const LEASE_DURATION_MS: number;

  export class PublicationError extends Error {
    constructor(status: number, message: string);
    status: number;
  }

  export function isTransientError(err: unknown): boolean;

  export interface TargetPrep {
    account: {
      id: string;
      name: string | null;
      platform: "FACEBOOK_PAGE" | "INSTAGRAM_BUSINESS";
      platformAccountId: string;
      status: string;
    };
    attempt: {
      id: string;
      organizationId: string;
      clientId: string;
      postId: string;
      socialAccountId: string;
      status: string;
      creationContainerId: string | null;
      remoteMediaId: string | null;
      remotePermalink: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      attemptNumber: number;
      executedAt: Date;
      leaseExpiresAt?: Date | null;
      createdAt: Date;
      updatedAt: Date;
    };
    accessToken?: string;
    previousContainerId?: string | null;
    skippedDueToError: boolean;
    alreadyPublished?: boolean;
  }

  export interface PreparePublicationParams {
    tx: Prisma.TransactionClient;
    organizationId: string;
    clientId: string;
    postId: string;
    socialAccountIds: string[];
    mediaAssetId?: string | null;
    masterKey: string | Buffer;
    scheduleId?: string | null;
    allowSkippingPublished?: boolean;
    auditCallback: (
      tx: Prisma.TransactionClient,
      entityId: string,
      action: string,
    ) => Promise<unknown>;
  }

  export interface PreparePublicationResult {
    post: {
      id: string;
      caption: string;
      hashtags: string | null;
    };
    mediaAsset: {
      id: string;
      storageKey: string;
      mimeType: string | null;
      byteSize: number | null;
      sha256: string | null;
    } | null;
    targets: TargetPrep[];
    uncertainAccount?: {
      id: string;
      name: string | null;
    } | null;
  }

  export interface ExecutePublicationParams {
    txRunner: <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ) => Promise<T>;
    auditCallback: (
      tx: Prisma.TransactionClient,
      entityId: string,
      action: string,
    ) => Promise<unknown>;
    publisher: MetaPublisherAdapter;
    prepResult: PreparePublicationResult;
    organizationId: string;
    clientId: string;
    appUrl: string;
    redis: Redis;
    onBeforePublish?: () => Promise<void>;
    isScheduler?: boolean;
  }

  export interface ExecutePublicationResult {
    attempts: PublicationAttemptDto[];
    hasFailures: boolean;
    hasUncertain: boolean;
    hasSuccess: boolean;
    allSuccess: boolean;
  }

  export function preparePublication(
    params: PreparePublicationParams,
  ): Promise<PreparePublicationResult>;

  export function executePublication(
    params: ExecutePublicationParams,
  ): Promise<ExecutePublicationResult>;
}
