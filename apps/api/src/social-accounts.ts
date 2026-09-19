import type { Express, Request, Response } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import {
  createCredentialCrypto,
  parseMasterKey,
  type Prisma,
  type CredentialContext,
} from "@socialflow/db";
import type { Config } from "@socialflow/config";
import {
  socialAccountDto,
  metaAuthorizeResponse,
  metaCallbackQuery,
  disconnectAccountResponse,
  metaDiscoveryResponse,
  connectSocialAccountsInput,
  connectSocialAccountsResponse,
  type SocialAccountDto,
  type Role,
} from "@socialflow/contracts";

export type Scope = <T>(
  req: Request,
  org: string,
  fn: (
    tx: Prisma.TransactionClient,
    userId: string,
    admin: boolean,
  ) => Promise<T>,
) => Promise<T>;

export interface SocialAccountDependencies {
  graphBaseUrl?: string;
  appId?: string;
  appSecret?: string;
  masterKey?: string | Buffer;
  lockTtlSeconds?: number;
  cleanupDiscovery?: (discoveryKey: string) => Promise<unknown>;
  onBeforeAccess?: () => Promise<void>;
  onTransactionStart?: (tx: Prisma.TransactionClient) => Promise<void>;
  onBeforeCreateConsumption?: () => Promise<void>;
  onBeforeTransactionCommit?: () => Promise<void>;
  onPostgresCommit?: () => Promise<void>;
}

export class SocialAccountError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "SocialAccountError";
  }
}

const META_DEFAULT_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_content_publish",
];

export function sanitizeSocialAccount(account: {
  id: string;
  organizationId: string;
  clientId: string;
  platform: "FACEBOOK_PAGE" | "INSTAGRAM_BUSINESS";
  platformAccountId: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  status: "ACTIVE" | "EXPIRED" | "REVOKED" | "DISCONNECTED";
  metadata?: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
}): SocialAccountDto {
  return socialAccountDto.parse({
    id: account.id,
    organizationId: account.organizationId,
    clientId: account.clientId,
    platform: account.platform,
    platformAccountId: account.platformAccountId,
    name: account.name,
    username: account.username ?? null,
    avatarUrl: account.avatarUrl ?? null,
    status: account.status,
    metadata:
      account.metadata && typeof account.metadata === "object"
        ? (account.metadata as Record<string, unknown>)
        : null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  });
}

export function registerSocialAccounts(
  server: Express,
  scoped: Scope,
  redis: Redis,
  config: Config,
  dependencies?: SocialAccountDependencies,
) {
  const graphBaseUrl =
    dependencies?.graphBaseUrl ??
    config.META_GRAPH_URL ??
    "https://graph.facebook.com";
  const appId = dependencies?.appId ?? config.META_APP_ID;
  const appSecret = dependencies?.appSecret ?? config.META_APP_SECRET;
  const masterKey = dependencies?.masterKey ?? config.CREDENTIAL_MASTER_KEY;

  const param = (req: Request, name: string): string => {
    const val = req.params[name];
    if (val !== undefined) return String(val);
    if (name === "clientId" && req.params.client !== undefined) {
      return String(req.params.client);
    }
    if (name === "accountId" && req.params.id !== undefined) {
      return String(req.params.id);
    }
    return "";
  };

  async function accessScope<T>(
    req: Request,
    org: string,
    clientId: string,
    allowedRoles: Role[],
    fn: (
      tx: Prisma.TransactionClient,
      userId: string,
      role: Role,
      admin: boolean,
    ) => Promise<T>,
  ) {
    return scoped(req, org, async (tx, userId, admin) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, organizationId: org, active: true },
      });
      if (!client) throw new SocialAccountError(404, "Cliente não encontrado.");

      let effectiveRole: Role = admin ? "ADMIN" : "CLIENT_VIEWER";
      if (!admin) {
        const clientMembership = await tx.membership.findFirst({
          where: {
            userId,
            organizationId: org,
            clientId,
            active: true,
          },
        });
        if (!clientMembership) {
          throw new SocialAccountError(404, "Cliente não encontrado.");
        }
        effectiveRole = clientMembership.role;
      } else {
        const orgMembership = await tx.membership.findFirst({
          where: {
            userId,
            organizationId: org,
            clientId: null,
            active: true,
          },
        });
        if (orgMembership) {
          effectiveRole = orgMembership.role;
        }
      }

      if (!allowedRoles.includes(effectiveRole)) {
        throw new SocialAccountError(
          403,
          "Acesso não autorizado para o seu perfil.",
        );
      }

      return fn(tx, userId, effectiveRole, admin);
    });
  }

  async function access<T>(
    req: Request,
    allowedRoles: Role[],
    fn: (
      tx: Prisma.TransactionClient,
      userId: string,
      role: Role,
      admin: boolean,
    ) => Promise<T>,
  ) {
    const org = param(req, "org");
    const clientId = param(req, "clientId");
    return accessScope(req, org, clientId, allowedRoles, fn);
  }

  const audit = (
    tx: Prisma.TransactionClient,
    req: Request,
    userId: string,
    entityId: string,
    action: string,
  ) =>
    tx.auditLog.create({
      data: {
        organizationId: param(req, "org"),
        actorUserId: userId,
        entityId,
        action,
      },
    });

  function handler(fn: (req: Request, res: Response) => Promise<unknown>) {
    return async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (error: unknown) {
        const status =
          error &&
          typeof error === "object" &&
          "status" in error &&
          typeof error.status === "number"
            ? error.status
            : error instanceof SocialAccountError
              ? error.status
              : 503;

        if (status !== 503) {
          res.status(status).json({
            message:
              error instanceof Error ? error.message : "Erro na requisição.",
          });
          return;
        }

        console.error(
          JSON.stringify({
            event: "social_accounts_request_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        if (!res.headersSent) {
          res
            .status(503)
            .json({ message: "Serviço indisponível. Tente novamente." });
        }
      }
    };
  }

  // --- 1. META AUTHORIZE ---
  const authorizeHandler = handler(async (req, res) => {
    await access(req, ["OWNER", "ADMIN", "EDITOR"], async (tx, userId) => {
      if (!appId || !appSecret || !masterKey) {
        throw new SocialAccountError(
          503,
          "Integração com a Meta não está configurada.",
        );
      }

      try {
        parseMasterKey(masterKey);
      } catch {
        throw new SocialAccountError(
          503,
          "Chave de criptografia de credenciais inválida no servidor.",
        );
      }

      const organizationId = param(req, "org");
      const clientId = param(req, "clientId");

      // PKCE: code_verifier and code_challenge S256
      const codeVerifier = randomBytes(32).toString("base64url");
      const codeChallenge = createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");

      // Unpredictable cryptographic state
      const state = randomBytes(32).toString("base64url");

      // Session binding hash
      const sessionHash = createHash("sha256")
        .update(req.headers.cookie ?? "")
        .digest("hex");

      // Store in Redis with TTL 600s (10 minutes)
      const stateKey = `meta:oauth:state:${state}`;
      const statePayload = JSON.stringify({
        organizationId,
        clientId,
        userId,
        sessionHash,
        codeVerifier,
        codeChallenge,
        createdAt: Date.now(),
      });
      await redis.set(stateKey, statePayload, "EX", 600);

      const callbackUrl = `${config.APP_URL}/api/integrations/meta/callback`;

      const authParams = new URLSearchParams({
        client_id: appId,
        redirect_uri: callbackUrl,
        state,
        response_type: "code",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      if (config.META_CONFIG_ID) {
        authParams.set("config_id", config.META_CONFIG_ID);
        authParams.set("override_default_response_type", "true");
      } else {
        authParams.set("scope", META_DEFAULT_SCOPES.join(","));
      }

      // Construct dialog url (allows mock base URL override for local testing)
      const dialogBase = graphBaseUrl.includes("facebook.com")
        ? "https://www.facebook.com/v21.0/dialog/oauth"
        : `${graphBaseUrl}/v21.0/dialog/oauth`;

      const fullUrl = `${dialogBase}?${authParams.toString()}`;

      const responsePayload = metaAuthorizeResponse.parse({
        url: fullUrl,
        authorizationUrl: fullUrl,
        state,
      });

      res.status(200).json(responsePayload);
    });
  });

  server.get(
    "/api/organizations/:org/clients/:clientId/integrations/meta/authorize",
    authorizeHandler,
  );
  server.get(
    "/api/organizations/:org/clients/:client/integrations/meta/authorize",
    authorizeHandler,
  );

  // --- 2. META CALLBACK ---
  const callbackHandler = handler(async (req, res) => {
    const isBrowserNavigation =
      req.headers["sec-fetch-dest"] === "document" ||
      req.headers["sec-fetch-mode"] === "navigate" ||
      (typeof req.headers.accept === "string" &&
        req.headers.accept.includes("text/html") &&
        !req.headers.accept.startsWith("application/json"));

    // Consent cancellation or error from Meta
    if (req.query.error) {
      const state =
        typeof req.query.state === "string" ? req.query.state : undefined;
      let targetOrg = "";
      let targetClient = "";

      if (state) {
        const stateKey = `meta:oauth:state:${state}`;
        const stateRaw = await redis.eval(
          "local v = redis.call('get', KEYS[1]); if v then redis.call('del', KEYS[1]) end; return v",
          1,
          stateKey,
        );
        if (stateRaw && typeof stateRaw === "string") {
          try {
            const parsed = JSON.parse(stateRaw);
            targetOrg = parsed.organizationId || "";
            targetClient = parsed.clientId || "";
          } catch {
            // Ignore parse failure
          }
        }
      }

      if (isBrowserNavigation) {
        const redirectTarget =
          targetOrg && targetClient
            ? `/?org=${encodeURIComponent(targetOrg)}&client=${encodeURIComponent(targetClient)}&meta_error=consent_cancelled`
            : `/?meta_error=consent_cancelled`;
        res.redirect(302, redirectTarget);
        return;
      }

      throw new SocialAccountError(
        400,
        "Consentimento cancelado pelo usuário na Meta.",
      );
    }

    if (!appId || !appSecret || !masterKey) {
      if (isBrowserNavigation) {
        res.redirect(302, "/?meta_error=not_configured");
        return;
      }
      throw new SocialAccountError(
        503,
        "Integração com a Meta não está configurada.",
      );
    }

    let resolvedMasterKey: Buffer;
    try {
      resolvedMasterKey = parseMasterKey(masterKey);
    } catch {
      if (isBrowserNavigation) {
        res.redirect(302, "/?meta_error=not_configured");
        return;
      }
      throw new SocialAccountError(
        503,
        "Chave de criptografia de credenciais inválida no servidor.",
      );
    }

    const queryParsed = metaCallbackQuery.safeParse(req.query);
    if (!queryParsed.success) {
      if (isBrowserNavigation) {
        res.redirect(302, "/?meta_error=invalid_callback");
        return;
      }
      throw new SocialAccountError(
        400,
        "Parâmetros de callback inválidos ou incompletos.",
      );
    }

    const { code, state } = queryParsed.data;

    // Atomic single-use retrieval and deletion of cryptographic state
    const stateKey = `meta:oauth:state:${state}`;
    const stateRaw = await redis.eval(
      "local v = redis.call('get', KEYS[1]); if v then redis.call('del', KEYS[1]) end; return v",
      1,
      stateKey,
    );

    if (!stateRaw || typeof stateRaw !== "string") {
      if (isBrowserNavigation) {
        res.redirect(302, "/?meta_error=state_expired");
        return;
      }
      throw new SocialAccountError(
        400,
        "State inválido, expirado ou já utilizado.",
      );
    }

    let storedState: {
      organizationId: string;
      clientId: string;
      userId: string;
      sessionHash?: string;
      codeVerifier: string;
      codeChallenge?: string;
    };
    try {
      storedState = JSON.parse(stateRaw);
    } catch {
      if (isBrowserNavigation) {
        res.redirect(302, "/?meta_error=state_corrupted");
        return;
      }
      throw new SocialAccountError(400, "Dados de state corrompidos.");
    }

    const {
      organizationId,
      clientId,
      userId: stateUserId,
      sessionHash,
      codeVerifier,
    } = storedState;

    if (!organizationId || !clientId || !stateUserId || !codeVerifier) {
      if (isBrowserNavigation) {
        res.redirect(302, "/?meta_error=state_corrupted");
        return;
      }
      throw new SocialAccountError(400, "Dados de state corrompidos.");
    }

    // Tenant, user and session isolation check
    const currentSessionHash = createHash("sha256")
      .update(req.headers.cookie ?? "")
      .digest("hex");

    if (!sessionHash || sessionHash !== currentSessionHash) {
      if (isBrowserNavigation) {
        res.redirect(302, "/?meta_error=forbidden");
        return;
      }
      throw new SocialAccountError(
        403,
        "Tentativa de manipulação de escopo entre tenants, usuários ou sessões detectada.",
      );
    }

    // Revalidate permissions strictly using stored tenant scope and user
    try {
      await accessScope(
        req,
        organizationId,
        clientId,
        ["OWNER", "ADMIN", "EDITOR"],
        async (tx, authenticatedUserId) => {
          if (stateUserId !== authenticatedUserId) {
            throw new SocialAccountError(
              403,
              "Tentativa de manipulação de escopo entre tenants, usuários ou sessões detectada.",
            );
          }

          const callbackUrl = `${config.APP_URL}/api/integrations/meta/callback`;

          // 1. Real HTTP call to exchange code for user access token with PKCE code_verifier via POST
          const tokenEndpoint = `${graphBaseUrl}/v21.0/oauth/access_token`;
          const tokenParams = new URLSearchParams({
            client_id: appId,
            client_secret: appSecret,
            redirect_uri: callbackUrl,
            code,
            code_verifier: codeVerifier,
          });

          let tokenResponse: globalThis.Response;
          try {
            tokenResponse = await fetch(tokenEndpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
              },
              body: tokenParams.toString(),
            });
          } catch {
            throw new SocialAccountError(
              503,
              "Falha de conexão com a Graph API ao trocar token.",
            );
          }

          const tokenData = (await tokenResponse.json()) as Record<
            string,
            unknown
          >;
          if (!tokenResponse.ok) {
            const errorObj = tokenData.error as
              Record<string, unknown> | undefined;
            const msg =
              typeof errorObj?.message === "string"
                ? errorObj.message
                : "Falha na autenticação OAuth com a Meta.";
            throw new SocialAccountError(400, msg);
          }

          const userAccessToken = tokenData.access_token;
          if (typeof userAccessToken !== "string" || !userAccessToken) {
            throw new SocialAccountError(
              400,
              "Token de acesso da Meta não recebido.",
            );
          }

          // 2. Real HTTP call to query managed Facebook Pages and linked Instagram accounts
          const accountsEndpoint = `${graphBaseUrl}/v21.0/me/accounts`;
          const accountsParams = new URLSearchParams({
            fields:
              "id,name,access_token,category,instagram_business_account{id,username,name,profile_picture_url}",
          });

          let accountsResponse: globalThis.Response;
          try {
            accountsResponse = await fetch(
              `${accountsEndpoint}?${accountsParams.toString()}`,
              {
                method: "GET",
                headers: {
                  Accept: "application/json",
                  Authorization: `Bearer ${userAccessToken}`,
                },
              },
            );
          } catch {
            throw new SocialAccountError(
              503,
              "Falha de conexão ao consultar contas na Graph API.",
            );
          }

          const accountsData = (await accountsResponse.json()) as Record<
            string,
            unknown
          >;
          if (!accountsResponse.ok) {
            const errorObj = accountsData.error as
              Record<string, unknown> | undefined;
            const msg =
              typeof errorObj?.message === "string"
                ? errorObj.message
                : "Falha ao listar páginas da Meta.";
            throw new SocialAccountError(400, msg);
          }

          const pages = Array.isArray(accountsData.data)
            ? (accountsData.data as Record<string, unknown>[])
            : [];

          const credentialCrypto = createCredentialCrypto(resolvedMasterKey, 1);
          const discoveryId = randomUUID();
          const expiresAt = new Date(Date.now() + 600 * 1000).toISOString();

          interface StoredDiscoveryAsset {
            platformAccountId: string;
            platform: "FACEBOOK_PAGE" | "INSTAGRAM_BUSINESS";
            name: string;
            username: string | null;
            avatarUrl: string | null;
            linkedFacebookPageId: string | null;
            encryptedAccessToken: string;
            iv: string;
            authTag: string;
            keyVersion: number;
          }

          const storedAssets: StoredDiscoveryAsset[] = [];

          for (const page of pages) {
            const pageId = String(page.id);
            const pageName = String(page.name);
            const pageAccessToken = String(
              page.access_token || userAccessToken,
            );

            // Encrypt page token with AES-256-GCM and AAD bound to tenant & platformAccountId
            const pageContext: CredentialContext = {
              organizationId,
              clientId,
              platformAccountId: pageId,
              keyVersion: 1,
            };
            const pageEncrypted = credentialCrypto.encrypt(
              pageAccessToken,
              pageContext,
            );

            storedAssets.push({
              platformAccountId: pageId,
              platform: "FACEBOOK_PAGE",
              name: pageName,
              username: null,
              avatarUrl: null,
              linkedFacebookPageId: null,
              encryptedAccessToken: pageEncrypted.encryptedAccessToken,
              iv: pageEncrypted.iv,
              authTag: pageEncrypted.authTag,
              keyVersion: pageEncrypted.keyVersion,
            });

            // Linked Instagram Business Account if present
            const ig = page.instagram_business_account as
              Record<string, unknown> | undefined;
            if (ig && typeof ig.id === "string") {
              const igId = ig.id;
              const igName = String(ig.name || ig.username || pageName);
              const igUsername =
                typeof ig.username === "string" ? ig.username : null;
              const igAvatar =
                typeof ig.profile_picture_url === "string"
                  ? ig.profile_picture_url
                  : null;

              const igContext: CredentialContext = {
                organizationId,
                clientId,
                platformAccountId: igId,
                keyVersion: 1,
              };
              const igEncrypted = credentialCrypto.encrypt(
                pageAccessToken,
                igContext,
              );

              storedAssets.push({
                platformAccountId: igId,
                platform: "INSTAGRAM_BUSINESS",
                name: igName,
                username: igUsername,
                avatarUrl: igAvatar,
                linkedFacebookPageId: pageId,
                encryptedAccessToken: igEncrypted.encryptedAccessToken,
                iv: igEncrypted.iv,
                authTag: igEncrypted.authTag,
                keyVersion: igEncrypted.keyVersion,
              });
            }
          }

          // Save discovery session to Redis with TTL 600s (10 min)
          const discoveryKey = `meta:oauth:discovery:${discoveryId}`;
          const discoveryPayload = JSON.stringify({
            discoveryId,
            organizationId,
            clientId,
            userId: authenticatedUserId,
            sessionHash: currentSessionHash,
            createdAt: Date.now(),
            expiresAt,
            assets: storedAssets,
          });
          await redis.set(discoveryKey, discoveryPayload, "EX", 600);

          // Return sanitized discovery response (never tokens or ciphertexts)
          const responsePayload = metaDiscoveryResponse.parse({
            discoveryId,
            expiresAt,
            assets: storedAssets.map((asset) => ({
              platformAccountId: asset.platformAccountId,
              platform: asset.platform,
              name: asset.name,
              username: asset.username,
              avatarUrl: asset.avatarUrl,
              linkedFacebookPageId: asset.linkedFacebookPageId,
            })),
          });

          if (isBrowserNavigation) {
            const redirectTarget = `/?org=${encodeURIComponent(organizationId)}&client=${encodeURIComponent(clientId)}&discoveryId=${encodeURIComponent(discoveryId)}`;
            res.redirect(302, redirectTarget);
            return;
          }

          res.status(200).json(responsePayload);
        },
      );
    } catch (err) {
      if (isBrowserNavigation) {
        const code =
          err instanceof SocialAccountError && err.status === 403
            ? "forbidden"
            : "provider_error";
        res.redirect(
          302,
          `/?org=${encodeURIComponent(organizationId)}&client=${encodeURIComponent(clientId)}&meta_error=${code}`,
        );
        return;
      }
      throw err;
    }
  });

  server.get("/api/integrations/meta/callback", callbackHandler);
  server.get(
    "/api/organizations/:org/clients/:clientId/integrations/meta/callback",
    callbackHandler,
  );
  server.get(
    "/api/organizations/:org/clients/:client/integrations/meta/callback",
    callbackHandler,
  );

  // --- 2.1. META DISCOVERY QUERY ---
  const discoveryHandler = handler(async (req, res) => {
    const discoveryId = param(req, "discoveryId");
    if (!discoveryId) {
      throw new SocialAccountError(400, "discoveryId é obrigatório.");
    }

    await access(
      req,
      ["OWNER", "ADMIN", "EDITOR"],
      async (tx, authenticatedUserId) => {
        const organizationId = param(req, "org");
        const clientId = param(req, "clientId");

        const discoveryKey = `meta:oauth:discovery:${discoveryId}`;
        const discoveryRaw = await redis.get(discoveryKey);

        if (!discoveryRaw) {
          throw new SocialAccountError(
            404,
            "Sessão de descoberta expirada ou não encontrada. Inicie uma nova conexão.",
          );
        }

        let storedDiscovery: {
          discoveryId: string;
          organizationId: string;
          clientId: string;
          userId: string;
          sessionHash?: string;
          createdAt?: number;
          expiresAt: string;
          assets: Array<{
            platformAccountId: string;
            platform: "FACEBOOK_PAGE" | "INSTAGRAM_BUSINESS";
            name: string;
            username: string | null;
            avatarUrl: string | null;
            linkedFacebookPageId: string | null;
            encryptedAccessToken: string;
            iv: string;
            authTag: string;
            keyVersion: number;
          }>;
        };

        try {
          storedDiscovery = JSON.parse(discoveryRaw);
        } catch {
          throw new SocialAccountError(
            400,
            "Dados de sessão de descoberta corrompidos.",
          );
        }

        // Validate expiration
        if (new Date(storedDiscovery.expiresAt).getTime() <= Date.now()) {
          await redis.del(discoveryKey);
          throw new SocialAccountError(
            404,
            "Sessão de descoberta expirada. Inicie uma nova conexão.",
          );
        }

        // Revalidate tenant, user, and session isolation
        const currentSessionHash = createHash("sha256")
          .update(req.headers.cookie ?? "")
          .digest("hex");

        if (
          storedDiscovery.organizationId !== organizationId ||
          storedDiscovery.clientId !== clientId ||
          storedDiscovery.userId !== authenticatedUserId ||
          (storedDiscovery.sessionHash &&
            storedDiscovery.sessionHash !== currentSessionHash)
        ) {
          throw new SocialAccountError(
            403,
            "Tentativa de manipulação de escopo entre tenants, usuários ou sessões detectada.",
          );
        }

        // Return sanitized DTO only (NEVER expose secrets, ciphertexts, or tokens)
        const responsePayload = metaDiscoveryResponse.parse({
          discoveryId: storedDiscovery.discoveryId,
          expiresAt: storedDiscovery.expiresAt,
          assets: storedDiscovery.assets.map((asset) => ({
            platformAccountId: asset.platformAccountId,
            platform: asset.platform,
            name: asset.name,
            username: asset.username,
            avatarUrl: asset.avatarUrl,
            linkedFacebookPageId: asset.linkedFacebookPageId,
          })),
        });

        res.status(200).json(responsePayload);
      },
    );
  });

  server.get(
    "/api/organizations/:org/clients/:clientId/integrations/meta/discovery/:discoveryId",
    discoveryHandler,
  );
  server.get(
    "/api/organizations/:org/clients/:client/integrations/meta/discovery/:discoveryId",
    discoveryHandler,
  );

  // Helper to validate and resolve an existing consumption with strict user and scope matching
  async function resolveExistingConsumption(options: {
    tx: Prisma.TransactionClient;
    consumption: {
      organizationId: string;
      clientId: string;
      userId: string;
      selectedAssets: unknown;
      connectedAccountIds: string[];
    };
    userId: string;
    organizationId: string;
    clientId: string;
    selectedAssets: Array<{
      platform: "FACEBOOK_PAGE" | "INSTAGRAM_BUSINESS";
      platformAccountId: string;
    }>;
  }) {
    const {
      tx,
      consumption,
      userId,
      organizationId,
      clientId,
      selectedAssets,
    } = options;

    if (
      consumption.organizationId !== organizationId ||
      consumption.clientId !== clientId ||
      consumption.userId !== userId
    ) {
      throw new SocialAccountError(
        403,
        "Tentativa de manipulação de escopo entre tenants, usuários ou sessões detectada.",
      );
    }

    const savedAssets = consumption.selectedAssets as Array<{
      platform: string;
      platformAccountId: string;
    }>;
    const isDifferentSelection =
      savedAssets.length !== selectedAssets.length ||
      selectedAssets.some(
        (sel) =>
          !savedAssets.some(
            (saved) =>
              saved.platform === sel.platform &&
              saved.platformAccountId === sel.platformAccountId,
          ),
      );

    if (isDifferentSelection) {
      throw new SocialAccountError(
        409,
        "A sessão de descoberta já foi consumida com uma seleção diferente de ativos.",
      );
    }

    const accounts = await tx.socialAccount.findMany({
      where: {
        id: { in: consumption.connectedAccountIds },
        organizationId,
        clientId,
      },
    });

    return connectSocialAccountsResponse.parse({
      connectedAccounts: accounts.map(sanitizeSocialAccount),
    });
  }

  // --- 3. CONNECT SELECTED SOCIAL ACCOUNTS ---
  const connectHandler = handler(async (req, res) => {
    const inputParsed = connectSocialAccountsInput.safeParse(req.body);
    if (!inputParsed.success) {
      throw new SocialAccountError(
        400,
        "Dados de seleção de ativos inválidos ou vazios.",
      );
    }

    const { discoveryId, selectedAssets } = inputParsed.data;
    const lockKey = `meta:oauth:discovery:lock:${discoveryId}`;
    const discoveryKey = `meta:oauth:discovery:${discoveryId}`;

    // Item 3: Concurrency protection with random owner per lock
    const lockOwner = randomUUID();
    const lockTtlSeconds = dependencies?.lockTtlSeconds ?? 15;
    const acquired = await redis.set(
      lockKey,
      lockOwner,
      "EX",
      lockTtlSeconds,
      "NX",
    );
    if (!acquired) {
      throw new SocialAccountError(
        409,
        "Conexão de contas já em andamento para esta sessão de autorização.",
      );
    }

    try {
      if (dependencies?.onBeforeAccess) {
        await dependencies.onBeforeAccess();
      }

      let result;
      try {
        result = await access(
          req,
          ["OWNER", "ADMIN", "EDITOR"],
          async (tx, userId) => {
            if (dependencies?.onTransactionStart) {
              await dependencies.onTransactionStart(tx);
            }

            const organizationId = param(req, "org");
            const clientId = param(req, "clientId");

            // Item 1: Durable idempotency check in PostgreSQL
            const existingConsumption =
              await tx.oAuthDiscoveryConsumption.findUnique({
                where: { discoveryId },
              });

            if (existingConsumption) {
              return resolveExistingConsumption({
                tx,
                consumption: existingConsumption,
                userId,
                organizationId,
                clientId,
                selectedAssets,
              });
            }

            // If not yet consumed in PostgreSQL, read discovery from Redis
            const discoveryRaw = await redis.get(discoveryKey);
            if (!discoveryRaw || typeof discoveryRaw !== "string") {
              throw new SocialAccountError(
                400,
                "Sessão de descoberta expirada, inválida ou já utilizada.",
              );
            }

            let storedDiscovery: {
              discoveryId: string;
              organizationId: string;
              clientId: string;
              userId: string;
              sessionHash?: string;
              assets: Array<{
                platformAccountId: string;
                platform: "FACEBOOK_PAGE" | "INSTAGRAM_BUSINESS";
                name: string;
                username: string | null;
                avatarUrl: string | null;
                linkedFacebookPageId: string | null;
                encryptedAccessToken: string;
                iv: string;
                authTag: string;
                keyVersion: number;
              }>;
            };

            try {
              storedDiscovery = JSON.parse(discoveryRaw);
            } catch {
              throw new SocialAccountError(
                400,
                "Dados de sessão de descoberta corrompidos.",
              );
            }

            // Revalidate tenant, user, and session
            const currentSessionHash = createHash("sha256")
              .update(req.headers.cookie ?? "")
              .digest("hex");

            if (
              storedDiscovery.organizationId !== organizationId ||
              storedDiscovery.clientId !== clientId ||
              storedDiscovery.userId !== userId ||
              (storedDiscovery.sessionHash &&
                storedDiscovery.sessionHash !== currentSessionHash)
            ) {
              throw new SocialAccountError(
                403,
                "Tentativa de manipulação de escopo entre tenants, usuários ou sessões detectada.",
              );
            }

            // Validate that every selected asset exists in discovery session
            const matchedAssets: typeof storedDiscovery.assets = [];
            for (const selected of selectedAssets) {
              const matched = storedDiscovery.assets.find(
                (a) =>
                  a.platform === selected.platform &&
                  a.platformAccountId === selected.platformAccountId,
              );
              if (!matched) {
                throw new SocialAccountError(
                  400,
                  `Ativo ${selected.platformAccountId} (${selected.platform}) não encontrado na sessão de descoberta.`,
                );
              }
              matchedAssets.push(matched);
            }

            const connectedAccounts: SocialAccountDto[] = [];

            for (const asset of matchedAssets) {
              let account = await tx.socialAccount.findFirst({
                where: {
                  organizationId,
                  clientId,
                  platform: asset.platform,
                  platformAccountId: asset.platformAccountId,
                },
              });

              const metadata = asset.linkedFacebookPageId
                ? { linkedFacebookPageId: asset.linkedFacebookPageId }
                : null;

              if (!account) {
                account = await tx.socialAccount.create({
                  data: {
                    organizationId,
                    clientId,
                    platform: asset.platform,
                    platformAccountId: asset.platformAccountId,
                    name: asset.name,
                    username: asset.username,
                    avatarUrl: asset.avatarUrl,
                    status: "ACTIVE",
                    metadata: metadata ?? undefined,
                  },
                });
              } else {
                account = await tx.socialAccount.update({
                  where: { id: account.id },
                  data: {
                    name: asset.name,
                    username: asset.username,
                    avatarUrl: asset.avatarUrl,
                    status: "ACTIVE",
                    metadata: metadata ?? undefined,
                  },
                });
              }

              await tx.oAuthCredential.upsert({
                where: { socialAccountId: account.id },
                create: {
                  socialAccountId: account.id,
                  encryptedAccessToken: asset.encryptedAccessToken,
                  iv: asset.iv,
                  authTag: asset.authTag,
                  keyVersion: asset.keyVersion,
                  tokenType: "PAGE_ACCESS_TOKEN",
                  scopes: META_DEFAULT_SCOPES,
                  lastRefreshedAt: new Date(),
                },
                update: {
                  encryptedAccessToken: asset.encryptedAccessToken,
                  iv: asset.iv,
                  authTag: asset.authTag,
                  keyVersion: asset.keyVersion,
                  tokenType: "PAGE_ACCESS_TOKEN",
                  scopes: META_DEFAULT_SCOPES,
                  lastRefreshedAt: new Date(),
                },
              });

              await audit(
                tx,
                req,
                userId,
                account.id,
                "social_account.connected",
              );
              connectedAccounts.push(sanitizeSocialAccount(account));
            }

            // Item 1: Record consumption in PostgreSQL in the SAME transaction
            if (dependencies?.onBeforeCreateConsumption) {
              await dependencies.onBeforeCreateConsumption();
            }

            await tx.oAuthDiscoveryConsumption.create({
              data: {
                discoveryId,
                organizationId,
                clientId,
                userId,
                selectedAssets: selectedAssets.map((a) => ({
                  platform: a.platform,
                  platformAccountId: a.platformAccountId,
                })),
                connectedAccountIds: connectedAccounts.map((a) => a.id),
              },
            });

            if (dependencies?.onBeforeTransactionCommit) {
              await dependencies.onBeforeTransactionCommit();
            }

            return connectSocialAccountsResponse.parse({ connectedAccounts });
          },
        );
      } catch (err: unknown) {
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          err.code === "P2002"
        ) {
          // A concurrent transaction committed consumption for this discovery session first.
          // The losing transaction has completely rolled back in PostgreSQL.
          // Inspect the committed consumption in a clean transaction.
          const organizationId = param(req, "org");
          const clientId = param(req, "clientId") || param(req, "client");

          const recovered = await access(
            req,
            ["OWNER", "ADMIN", "EDITOR"],
            async (tx, userId) => {
              const committed = await tx.oAuthDiscoveryConsumption.findUnique({
                where: { discoveryId },
              });
              if (!committed) {
                return null;
              }
              return resolveExistingConsumption({
                tx,
                consumption: committed,
                userId,
                organizationId,
                clientId,
                selectedAssets,
              });
            },
          );

          if (!recovered) {
            throw new SocialAccountError(
              409,
              "Conflito de concorrência ao conectar contas.",
            );
          }
          result = recovered;
        } else {
          throw err;
        }
      }

      if (dependencies?.onPostgresCommit) {
        await dependencies.onPostgresCommit();
      }

      // Item 2: Handle Redis failure after commit as cleanup failure
      try {
        if (dependencies?.cleanupDiscovery) {
          await dependencies.cleanupDiscovery(discoveryKey);
        } else {
          await redis.del(discoveryKey);
        }
      } catch {
        console.error(
          JSON.stringify({
            event: "oauth_discovery_cleanup_failed",
            code: "REDIS_CLEANUP_FAILED",
            discoveryId,
            organizationId: param(req, "org"),
            clientId: param(req, "clientId") || param(req, "client"),
          }),
        );
      }

      res.status(200).json(result);
    } finally {
      // Item 3: Atomic release conditioned on lock owner
      const releaseLua = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      try {
        await redis.eval(releaseLua, 1, lockKey, lockOwner);
      } catch {
        // Safe: lock will automatically expire by TTL
      }
    }
  });

  server.post(
    "/api/organizations/:org/clients/:clientId/social-accounts/connect",
    connectHandler,
  );
  server.post(
    "/api/organizations/:org/clients/:client/social-accounts/connect",
    connectHandler,
  );

  // --- 3. LIST SOCIAL ACCOUNTS BY CLIENT ---
  const listHandler = handler(async (req, res) => {
    const accounts = await access(
      req,
      ["OWNER", "ADMIN", "EDITOR", "APPROVER", "CLIENT_VIEWER"],
      async (tx) => {
        const organizationId = param(req, "org");
        const clientId = param(req, "clientId");

        return tx.socialAccount.findMany({
          where: { organizationId, clientId },
          orderBy: { createdAt: "desc" },
          take: 100,
        });
      },
    );

    res.status(200).json(accounts.map(sanitizeSocialAccount));
  });

  server.get(
    "/api/organizations/:org/clients/:clientId/social-accounts",
    listHandler,
  );
  server.get(
    "/api/organizations/:org/clients/:client/social-accounts",
    listHandler,
  );

  // --- 4. DETAIL SOCIAL ACCOUNT ---
  const detailHandler = handler(async (req, res) => {
    const account = await access(
      req,
      ["OWNER", "ADMIN", "EDITOR", "APPROVER", "CLIENT_VIEWER"],
      async (tx) => {
        const organizationId = param(req, "org");
        const clientId = param(req, "clientId");
        const accountId = param(req, "accountId");

        const found = await tx.socialAccount.findFirst({
          where: { id: accountId, organizationId, clientId },
        });
        if (!found) {
          throw new SocialAccountError(404, "Conta social não encontrada.");
        }
        return found;
      },
    );

    res.status(200).json(sanitizeSocialAccount(account));
  });

  server.get(
    "/api/organizations/:org/clients/:clientId/social-accounts/:accountId",
    detailHandler,
  );
  server.get(
    "/api/organizations/:org/clients/:client/social-accounts/:id",
    detailHandler,
  );

  // --- 5. DISCONNECT / DELETE SOCIAL ACCOUNT ---
  const disconnectHandler = handler(async (req, res) => {
    const result = await access(
      req,
      ["OWNER", "ADMIN", "EDITOR"],
      async (tx, userId) => {
        const organizationId = param(req, "org");
        const clientId = param(req, "clientId");
        const accountId = param(req, "accountId");

        const account = await tx.socialAccount.findFirst({
          where: { id: accountId, organizationId, clientId },
        });
        if (!account) {
          throw new SocialAccountError(404, "Conta social não encontrada.");
        }

        // Update status to DISCONNECTED
        const updated = await tx.socialAccount.update({
          where: { id: account.id },
          data: { status: "DISCONNECTED" },
        });

        // Securely delete credential record from database
        await tx.oAuthCredential.deleteMany({
          where: { socialAccountId: account.id },
        });

        // Record audit trail
        await audit(tx, req, userId, account.id, "social_account.disconnected");

        return disconnectAccountResponse.parse({
          disconnected: true,
          id: updated.id,
          status: "DISCONNECTED",
        });
      },
    );

    res.status(200).json(result);
  });

  server.delete(
    "/api/organizations/:org/clients/:clientId/social-accounts/:accountId",
    disconnectHandler,
  );
  server.delete(
    "/api/organizations/:org/clients/:client/social-accounts/:id",
    disconnectHandler,
  );
  server.delete(
    "/api/organizations/:org/clients/:clientId/integrations/meta/accounts/:accountId",
    disconnectHandler,
  );
  server.delete(
    "/api/organizations/:org/clients/:client/integrations/meta/accounts/:id",
    disconnectHandler,
  );
}
