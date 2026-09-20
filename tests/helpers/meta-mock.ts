import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface RegisteredCodeOptions {
  codeChallenge?: string;
  userAccessToken?: string;
  pages?: Array<{
    id: string;
    name: string;
    accessToken?: string;
    access_token?: string;
    category?: string;
    instagramBusinessAccount?: {
      id: string;
      username: string;
      name?: string;
      profilePictureUrl?: string;
    };
    instagram_business_account?: {
      id: string;
      username: string;
      name?: string;
      profile_picture_url?: string;
    };
  }>;
}

export interface MetaMockServer {
  url: string;
  port: number;
  close: () => Promise<void>;
  registerCode: (code: string, options?: RegisteredCodeOptions) => void;
  invalidateCode: (code: string) => void;
}

export function startMetaMockServer(
  port = 0,
  host = "127.0.0.1",
): Promise<MetaMockServer> {
  const registeredCodes = new Map<string, RegisteredCodeOptions>();
  const tokenPages = new Map<string, unknown[]>();

  // Pre-seed a default valid code
  registeredCodes.set("valid_meta_code_123", {
    userAccessToken: "mock_user_access_token_secure",
  });

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const pathname = parsedUrl.pathname;
      const bodyParams = new URLSearchParams(body);

      // Helper to send JSON response
      const json = (status: number, data: unknown) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(data));
      };

      // 1. /v21.0/oauth/access_token
      if (
        pathname === "/v21.0/oauth/access_token" ||
        pathname === "/oauth/access_token"
      ) {
        const code =
          bodyParams.get("code") || parsedUrl.searchParams.get("code");
        const codeVerifier =
          bodyParams.get("code_verifier") ||
          parsedUrl.searchParams.get("code_verifier");

        if (!code) {
          return json(400, {
            error: {
              message: "Missing authorization code.",
              type: "OAuthException",
              code: 100,
            },
          });
        }

        const codeData = registeredCodes.get(code);
        if (!codeData) {
          return json(400, {
            error: {
              message: "Invalid verification code format or expired.",
              type: "OAuthException",
              code: 100,
            },
          });
        }

        // PKCE verification
        if (codeData.codeChallenge) {
          if (!codeVerifier) {
            return json(400, {
              error: {
                message: "Missing code_verifier for PKCE validation.",
                type: "OAuthException",
                code: 100,
              },
            });
          }

          const calculatedChallenge = createHash("sha256")
            .update(codeVerifier)
            .digest("base64url");

          if (calculatedChallenge !== codeData.codeChallenge) {
            return json(400, {
              error: {
                message: "Invalid code_verifier: hash mismatch.",
                type: "OAuthException",
                code: 100,
              },
            });
          }
        }

        const token =
          codeData.userAccessToken ?? `mock_user_access_token_${code}`;
        return json(200, {
          access_token: token,
          token_type: "bearer",
          expires_in: 5184000,
        });
      }

      // 2. /v21.0/me/accounts
      if (pathname === "/v21.0/me/accounts" || pathname === "/me/accounts") {
        const authHeader = req.headers.authorization;
        const queryToken = parsedUrl.searchParams.get("access_token");
        const token = authHeader?.replace(/^Bearer\s+/i, "") || queryToken;

        if (!token) {
          return json(401, {
            error: {
              message: "Invalid OAuth access token.",
              type: "OAuthException",
              code: 190,
            },
          });
        }

        const customPages = tokenPages.get(token);
        const pagesData = customPages ?? [
          {
            id: "page_mock_1001",
            name: "SocialFlow Facebook Page Test",
            access_token: "mock_page_token_xyz_987",
            category: "Marketing",
            instagram_business_account: {
              id: "ig_mock_2002",
              username: "socialflow_test_business",
              name: "SocialFlow Instagram Business",
              profile_picture_url: "https://example.com/avatar.png",
            },
          },
        ];

        return json(200, {
          data: pagesData,
          paging: {
            cursors: {
              before: "cursor_before",
              after: "cursor_after",
            },
          },
        });
      }

      // 3. Facebook: /{page-id}/photos
      if (
        pathname.match(/\/v21\.0\/[^/]+\/photos$/) ||
        pathname.match(/\/[^/]+\/photos$/)
      ) {
        const token =
          bodyParams.get("access_token") ||
          parsedUrl.searchParams.get("access_token");
        if (token === "invalid_or_expired_token") {
          return json(400, {
            error: {
              message: "Error validating access token: Session has expired.",
              type: "OAuthException",
              code: 190,
              error_subcode: 463,
            },
          });
        }
        return json(200, {
          id: "photo_mock_12345",
          post_id: "fb_post_mock_67890",
        });
      }

      // 4. Facebook: /{page-id}/feed
      if (
        pathname.match(/\/v21\.0\/[^/]+\/feed$/) ||
        pathname.match(/\/[^/]+\/feed$/)
      ) {
        return json(200, {
          id: "fb_post_feed_mock_99999",
        });
      }

      // 5. Instagram: /{ig-user-id}/media (Container Creation)
      if (
        pathname.match(/\/v21\.0\/[^/]+\/media$/) ||
        pathname.match(/\/[^/]+\/media$/)
      ) {
        const token =
          bodyParams.get("access_token") ||
          parsedUrl.searchParams.get("access_token");
        if (token === "invalid_or_expired_token") {
          return json(400, {
            error: {
              message: "Error validating access token: User changed password.",
              type: "OAuthException",
              code: 190,
              error_subcode: 460,
            },
          });
        }
        return json(200, {
          id: "ig_container_mock_55555",
        });
      }

      // 6. Instagram: /{container-id} (Container Status Check)
      if (pathname.includes("ig_container_mock_55555")) {
        return json(200, {
          status_code: "FINISHED",
          id: "ig_container_mock_55555",
        });
      }

      // 7. Instagram: /{ig-user-id}/media_publish
      if (
        pathname.match(/\/v21\.0\/[^/]+\/media_publish$/) ||
        pathname.match(/\/[^/]+\/media_publish$/)
      ) {
        return json(200, {
          id: "ig_published_media_88888",
        });
      }

      // 8. Instagram: /{media-id} (Permalink query)
      if (pathname.includes("ig_published_media_88888")) {
        return json(200, {
          id: "ig_published_media_88888",
          permalink: "https://www.instagram.com/p/MockPerm123/",
        });
      }

      // 404 for unknown endpoints
      return json(404, {
        error: {
          message: `Unknown path: ${pathname}`,
          type: "GraphMethodException",
          code: 100,
        },
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      const actualPort = addr.port;
      const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actualPort}`;

      resolve({
        url,
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
        registerCode: (code, options = {}) => {
          registeredCodes.set(code, options);
          const token =
            options.userAccessToken ?? `mock_user_access_token_${code}`;
          if (options.pages) {
            const normalizedPages = options.pages.map((p) => {
              const anyP = p as Record<string, unknown>;
              return {
                id: p.id,
                name: p.name,
                access_token:
                  anyP.access_token ??
                  anyP.accessToken ??
                  "mock_page_token_xyz_987",
                category: anyP.category ?? "Marketing",
                instagram_business_account:
                  anyP.instagram_business_account ??
                  anyP.instagramBusinessAccount ??
                  undefined,
              };
            });
            tokenPages.set(token, normalizedPages);
          }
        },
        invalidateCode: (code) => {
          registeredCodes.delete(code);
        },
      });
    });
  });
}
