import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  socialAccountDto,
  metaAuthorizeResponse,
  metaCallbackQuery,
  disconnectAccountResponse,
  metaDiscoveryResponse,
  connectSocialAccountsInput,
  connectSocialAccountsResponse,
} from "../../packages/contracts/src/social-account.js";
import { sanitizeSocialAccount } from "../../apps/api/src/social-accounts.js";

describe("Social Accounts DTOs and PKCE Unit Tests", () => {
  const validAccount = {
    id: randomUUID(),
    organizationId: "org-a",
    clientId: "client-a",
    platform: "FACEBOOK_PAGE" as const,
    platformAccountId: "fb_page_12345",
    name: "Minha Página",
    username: "minhapagina",
    avatarUrl: "https://example.com/page.jpg",
    status: "ACTIVE" as const,
    metadata: { verified: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("successfully parses valid SocialAccountDto", () => {
    const parsed = socialAccountDto.parse(validAccount);
    expect(parsed.id).toBe(validAccount.id);
    expect(parsed.name).toBe("Minha Página");
    expect(parsed.platform).toBe("FACEBOOK_PAGE");
  });

  it("strictly rejects extra secret fields like accessToken or iv in socialAccountDto", () => {
    const withSecrets = {
      ...validAccount,
      accessToken: "secret_access_token_should_never_be_here",
      encryptedAccessToken: "ciphertext",
      iv: "iv_base64",
      authTag: "auth_tag_base64",
    };

    expect(() => socialAccountDto.parse(withSecrets)).toThrow();
  });

  it("sanitizeSocialAccount strips any credential fields and returns clean DTO", () => {
    const rawWithExtra = {
      ...validAccount,
      createdAt: new Date(),
      updatedAt: new Date(),
      extraConfidentialField: "TOP_SECRET",
    };

    const sanitized = sanitizeSocialAccount(rawWithExtra);
    expect(sanitized.id).toBe(validAccount.id);
    expect(sanitized).not.toHaveProperty("extraConfidentialField");
    expect(sanitized).not.toHaveProperty("accessToken");
    expect(sanitized).not.toHaveProperty("encryptedAccessToken");
    expect(sanitized).not.toHaveProperty("iv");
    expect(sanitized).not.toHaveProperty("authTag");
  });

  it("validates PKCE code_challenge calculation according to RFC 7636", () => {
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeChallenge.length).toBeGreaterThanOrEqual(43);
    // base64url should not contain '+', '/', or '='
    expect(codeVerifier).not.toMatch(/[+/=]/);
    expect(codeChallenge).not.toMatch(/[+/=]/);

    // Verify deterministic hashing
    const recalculated = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    expect(recalculated).toBe(codeChallenge);
  });

  it("validates metaAuthorizeResponse contract", () => {
    const res = metaAuthorizeResponse.parse({
      url: "https://www.facebook.com/v21.0/dialog/oauth?client_id=123",
      authorizationUrl:
        "https://www.facebook.com/v21.0/dialog/oauth?client_id=123",
      state: "secure_random_state_string_123456",
    });
    expect(res.state).toBe("secure_random_state_string_123456");

    expect(() =>
      metaAuthorizeResponse.parse({
        url: "not-a-url",
        authorizationUrl: "not-a-url",
        state: "short",
      }),
    ).toThrow();
  });

  it("validates metaCallbackQuery parameters", () => {
    expect(
      metaCallbackQuery.parse({
        code: "auth_code_123",
        state: "valid_state_456",
      }),
    ).toEqual({
      code: "auth_code_123",
      state: "valid_state_456",
    });

    expect(() => metaCallbackQuery.parse({})).toThrow();
    expect(() => metaCallbackQuery.parse({ code: "" })).toThrow();
  });

  it("validates disconnectAccountResponse contract", () => {
    const id = randomUUID();
    const parsed = disconnectAccountResponse.parse({
      disconnected: true,
      id,
      status: "DISCONNECTED",
    });
    expect(parsed.disconnected).toBe(true);
    expect(parsed.status).toBe("DISCONNECTED");

    expect(() =>
      disconnectAccountResponse.parse({
        disconnected: false,
        id,
        status: "ACTIVE",
      }),
    ).toThrow();
  });

  it("validates metaDiscoveryResponse contract rejecting extra secret fields", () => {
    const discoveryId = randomUUID();
    const expiresAt = new Date().toISOString();
    const validDiscovery = {
      discoveryId,
      expiresAt,
      assets: [
        {
          platformAccountId: "page_123",
          platform: "FACEBOOK_PAGE" as const,
          name: "Página de Teste",
          username: null,
          avatarUrl: null,
          linkedFacebookPageId: null,
        },
      ],
    };

    const parsed = metaDiscoveryResponse.parse(validDiscovery);
    expect(parsed.discoveryId).toBe(discoveryId);
    expect(parsed.assets).toHaveLength(1);

    // Reject leaked token inside discovery assets
    const withToken = {
      ...validDiscovery,
      assets: [
        {
          ...validDiscovery.assets[0],
          accessToken: "secret_should_never_be_here",
        },
      ],
    };
    expect(() => metaDiscoveryResponse.parse(withToken)).toThrow();
  });

  it("validates connectSocialAccountsInput contract requiring non-empty selectedAssets", () => {
    const discoveryId = randomUUID();
    const valid = {
      discoveryId,
      selectedAssets: [
        {
          platform: "FACEBOOK_PAGE" as const,
          platformAccountId: "page_123",
        },
      ],
    };

    const parsed = connectSocialAccountsInput.parse(valid);
    expect(parsed.discoveryId).toBe(discoveryId);
    expect(parsed.selectedAssets).toHaveLength(1);

    // Rejects empty selected assets
    expect(() =>
      connectSocialAccountsInput.parse({
        discoveryId,
        selectedAssets: [],
      }),
    ).toThrow();

    // Rejects invalid platform
    expect(() =>
      connectSocialAccountsInput.parse({
        discoveryId,
        selectedAssets: [
          {
            platform: "TIKTOK" as const,
            platformAccountId: "123",
          },
        ],
      }),
    ).toThrow();
  });

  it("validates connectSocialAccountsResponse contract", () => {
    const parsed = connectSocialAccountsResponse.parse({
      connectedAccounts: [validAccount],
    });
    expect(parsed.connectedAccounts).toHaveLength(1);
    expect(parsed.connectedAccounts[0]?.id).toBe(validAccount.id);
  });
});
