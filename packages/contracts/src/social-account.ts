import { z } from "zod";

export const socialPlatforms = ["FACEBOOK_PAGE", "INSTAGRAM_BUSINESS"] as const;
export type SocialPlatform = (typeof socialPlatforms)[number];

export const socialAccountStatuses = [
  "ACTIVE",
  "EXPIRED",
  "REVOKED",
  "DISCONNECTED",
] as const;
export type SocialAccountStatus = (typeof socialAccountStatuses)[number];

export const socialAccountDto = z.strictObject({
  id: z.string().uuid(),
  organizationId: z.string(),
  clientId: z.string(),
  platform: z.enum(socialPlatforms),
  platformAccountId: z.string(),
  name: z.string(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  status: z.enum(socialAccountStatuses),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
});
export type SocialAccountDto = z.infer<typeof socialAccountDto>;

export const metaAuthorizeResponse = z.strictObject({
  url: z.string().url(),
  authorizationUrl: z.string().url(),
  state: z.string().min(16),
});
export type MetaAuthorizeResponse = z.infer<typeof metaAuthorizeResponse>;

export const metaCallbackQuery = z.strictObject({
  code: z.string().min(1),
  state: z.string().min(1),
});
export type MetaCallbackQuery = z.infer<typeof metaCallbackQuery>;

export const disconnectAccountResponse = z.strictObject({
  disconnected: z.literal(true),
  id: z.string().uuid(),
  status: z.literal("DISCONNECTED"),
});
export type DisconnectAccountResponse = z.infer<
  typeof disconnectAccountResponse
>;

export const discoveredSocialAssetDto = z.strictObject({
  platformAccountId: z.string().min(1),
  platform: z.enum(socialPlatforms),
  name: z.string().min(1),
  username: z.string().nullable().default(null),
  avatarUrl: z.string().nullable().default(null),
  linkedFacebookPageId: z.string().nullable().default(null),
});
export type DiscoveredSocialAssetDto = z.infer<typeof discoveredSocialAssetDto>;

export const metaDiscoveryResponse = z.strictObject({
  discoveryId: z.string().uuid(),
  expiresAt: z.string(),
  assets: z.array(discoveredSocialAssetDto),
});
export type MetaDiscoveryResponse = z.infer<typeof metaDiscoveryResponse>;

export const selectedAssetInput = z.strictObject({
  platform: z.enum(socialPlatforms),
  platformAccountId: z.string().min(1),
});
export type SelectedAssetInput = z.infer<typeof selectedAssetInput>;

export const connectSocialAccountsInput = z.strictObject({
  discoveryId: z.string().uuid(),
  selectedAssets: z
    .array(selectedAssetInput)
    .min(1, "Selecione ao menos um ativo para conectar."),
});
export type ConnectSocialAccountsInput = z.infer<
  typeof connectSocialAccountsInput
>;

export const connectSocialAccountsResponse = z.strictObject({
  connectedAccounts: z.array(socialAccountDto),
});
export type ConnectSocialAccountsResponse = z.infer<
  typeof connectSocialAccountsResponse
>;

export const publicationAttemptStatuses = [
  "PENDING",
  "PROCESSING",
  "CONTAINER_CREATED",
  "PUBLISHED",
  "FAILED",
  "UNCERTAIN",
] as const;
export type PublicationAttemptStatus =
  (typeof publicationAttemptStatuses)[number];

export const publicationAttemptDto = z.strictObject({
  id: z.string().uuid(),
  organizationId: z.string(),
  clientId: z.string(),
  postId: z.string().uuid(),
  socialAccountId: z.string().uuid(),
  platform: z.enum(socialPlatforms),
  status: z.enum(publicationAttemptStatuses),
  creationContainerId: z.string().nullable().optional(),
  remoteMediaId: z.string().nullable().optional(),
  remotePermalink: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  attemptNumber: z.number().int().min(1),
  executedAt: z.union([z.string(), z.date()]),
  leaseExpiresAt: z.union([z.string(), z.date()]).nullable().optional(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
});
export type PublicationAttemptDto = z.infer<typeof publicationAttemptDto>;

export const publishPostInput = z.strictObject({
  socialAccountIds: z
    .array(z.string().uuid())
    .min(1, "Selecione ao menos uma conta social para publicação."),
  mediaAssetId: z
    .string()
    .uuid()
    .optional()
    .nullable()
    .transform((val) => (val === "" || val === undefined ? null : val)),
  idempotencyKey: z
    .string()
    .min(8, "Chave de idempotência deve ter no mínimo 8 caracteres.")
    .max(128),
});
export type PublishPostInput = z.infer<typeof publishPostInput>;

export const publishPostResponse = z.strictObject({
  postId: z.string().uuid(),
  success: z.boolean(),
  attempts: z.array(publicationAttemptDto),
});
export type PublishPostResponse = z.infer<typeof publishPostResponse>;

export const resolvePublicationAttemptInput = z.strictObject({
  decision: z.enum(["CONFIRM_PUBLISHED", "CONFIRM_FAILED", "DISMISS"]),
  remoteMediaId: z.string().max(255).optional().nullable(),
  remotePermalink: z.string().url().max(1000).optional().nullable(),
  notes: z.string().max(1000).optional(),
});
export type ResolvePublicationAttemptInput = z.infer<
  typeof resolvePublicationAttemptInput
>;

export const resolvePublicationAttemptResponse = z.strictObject({
  success: z.boolean(),
  attempt: publicationAttemptDto,
});
export type ResolvePublicationAttemptResponse = z.infer<
  typeof resolvePublicationAttemptResponse
>;
