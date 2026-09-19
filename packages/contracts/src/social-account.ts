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
