import { describe, expect, it, vi } from "vitest";
import {
  MetaPublisherAdapter,
  MetaAuthError,
  MetaMediaError,
  MetaTimeoutError,
  MetaPermissionError,
  MetaRateLimitError,
} from "../../apps/api/src/meta-publisher.js";

describe("MetaPublisherAdapter Unit Tests", () => {
  const secretToken = "EAA_VERY_SECRET_PAGE_ACCESS_TOKEN_12345";

  it("publica foto no Facebook com sucesso e retorna remoteMediaId e permalink", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "photo_987654321",
        post_id: "page_123_post_456",
      }),
    });

    const publisher = new MetaPublisherAdapter({
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await publisher.publishFacebook({
      pageId: "page_123",
      accessToken: secretToken,
      caption: "Legenda de teste com imagem",
      imageUrl: "https://example.com/image.jpg",
    });

    expect(result.remoteMediaId).toBe("page_123_post_456");
    expect(result.remotePermalink).toBe(
      "https://www.facebook.com/page_123_post_456",
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toContain("/v21.0/page_123/photos");
    expect(calledInit.method).toBe("POST");
    expect(calledInit.body).toContain("caption=Legenda+de+teste+com+imagem");
    expect(calledInit.body).toContain(
      "url=https%3A%2F%2Fexample.com%2Fimage.jpg",
    );
  });

  it("publica post de texto puro no Facebook via /feed", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "feed_post_789",
      }),
    });

    const publisher = new MetaPublisherAdapter({
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await publisher.publishFacebook({
      pageId: "page_123",
      accessToken: secretToken,
      caption: "Texto sem imagem",
    });

    expect(result.remoteMediaId).toBe("feed_post_789");
    expect(result.remotePermalink).toBe(
      "https://www.facebook.com/feed_post_789",
    );

    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("/v21.0/page_123/feed");
  });

  it("executa o ciclo completo de publicação no Instagram com container e polling", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      // 1. Criação do container
      if (url.includes("/ig_user_1/media") && !url.includes("media_publish")) {
        return {
          ok: true,
          json: async () => ({ id: "ig_container_1001" }),
        };
      }
      // 2. Consulta de status do container
      if (url.includes("ig_container_1001")) {
        return {
          ok: true,
          json: async () => ({
            status_code: "FINISHED",
            id: "ig_container_1001",
          }),
        };
      }
      // 3. Publicação do container
      if (url.includes("/ig_user_1/media_publish")) {
        return {
          ok: true,
          json: async () => ({ id: "ig_media_final_2002" }),
        };
      }
      // 4. Busca do permalink
      if (url.includes("ig_media_final_2002")) {
        return {
          ok: true,
          json: async () => ({
            permalink: "https://www.instagram.com/p/Cxyz123/",
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });

    const publisher = new MetaPublisherAdapter({
      fetchFn: mockFetch as unknown as typeof fetch,
      pollDelayMs: 10,
    });

    const containerCreatedSpy = vi.fn();

    const result = await publisher.publishInstagram(
      {
        igUserId: "ig_user_1",
        accessToken: secretToken,
        imageUrl: "https://cdn.example.com/photo.jpg",
        caption: "Minha foto no Instagram #socialflow",
      },
      containerCreatedSpy,
    );

    expect(containerCreatedSpy).toHaveBeenCalledWith("ig_container_1001");
    expect(result.remoteMediaId).toBe("ig_media_final_2002");
    expect(result.remotePermalink).toBe("https://www.instagram.com/p/Cxyz123/");
    expect(result.creationContainerId).toBe("ig_container_1001");
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("trata polling de container do Instagram que leva múltiplas tentativas antes de FINISHED", async () => {
    let pollCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/media") && !url.includes("media_publish")) {
        return { ok: true, json: async () => ({ id: "c_1" }) };
      }
      if (url.includes("c_1")) {
        pollCount++;
        if (pollCount < 3) {
          return {
            ok: true,
            json: async () => ({ status_code: "IN_PROGRESS" }),
          };
        }
        return { ok: true, json: async () => ({ status_code: "FINISHED" }) };
      }
      if (url.includes("/media_publish")) {
        return { ok: true, json: async () => ({ id: "ig_published_1" }) };
      }
      return {
        ok: true,
        json: async () => ({ permalink: "https://instagram.com/p/test" }),
      };
    });

    const publisher = new MetaPublisherAdapter({
      fetchFn: mockFetch as unknown as typeof fetch,
      pollDelayMs: 5,
      pollMaxAttempts: 5,
    });

    const result = await publisher.publishInstagram({
      igUserId: "ig_user_1",
      accessToken: secretToken,
      imageUrl: "https://cdn.example.com/photo.jpg",
      caption: "Test",
    });

    expect(result.remoteMediaId).toBe("ig_published_1");
    expect(pollCount).toBe(3);
  });

  it("lança MetaTimeoutError quando o container excede o limite de tentativas de polling", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/media") && !url.includes("media_publish")) {
        return { ok: true, json: async () => ({ id: "c_slow" }) };
      }
      return { ok: true, json: async () => ({ status_code: "IN_PROGRESS" }) };
    });

    const publisher = new MetaPublisherAdapter({
      fetchFn: mockFetch as unknown as typeof fetch,
      pollDelayMs: 5,
      pollMaxAttempts: 3,
    });

    await expect(
      publisher.publishInstagram({
        igUserId: "ig_user_1",
        accessToken: secretToken,
        imageUrl: "https://cdn.example.com/photo.jpg",
        caption: "Test",
      }),
    ).rejects.toThrow(MetaTimeoutError);
  });

  it("converte erro 190 da Meta em MetaAuthError e limpa o token da mensagem", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: `Error validating access token: Session has expired. token=${secretToken}`,
          type: "OAuthException",
          code: 190,
          error_subcode: 463,
        },
      }),
    });

    const publisher = new MetaPublisherAdapter({
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    let caughtError: unknown;
    try {
      await publisher.publishFacebook({
        pageId: "page_123",
        accessToken: secretToken,
        caption: "Legenda",
        imageUrl: "https://example.com/image.jpg",
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(MetaAuthError);
    const authErr = caughtError as MetaAuthError;
    expect(authErr.code).toBe(190);
    expect(authErr.subcode).toBe(463);
    // Garante que o segredo foi totalmente sanitizado
    expect(authErr.message).not.toContain(secretToken);
    expect(authErr.message).toContain("[REDACTED]");
  });

  it("converte erro de mídia (36003 / aspect ratio) em MetaMediaError", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message:
            "The aspect ratio is not supported. Please use 1:1, 4:5 or 1.91:1",
          type: "IGApiException",
          code: 36003,
        },
      }),
    });

    const publisher = new MetaPublisherAdapter({
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      publisher.createInstagramContainer({
        igUserId: "ig_user_1",
        accessToken: secretToken,
        imageUrl: "https://example.com/bad_ratio.jpg",
        caption: "Legenda",
      }),
    ).rejects.toThrow(MetaMediaError);
  });

  it("converte erro 200 de permissão em MetaPermissionError", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: {
          message: "(#200) Provide valid permissions: pages_manage_posts",
          type: "OAuthException",
          code: 200,
        },
      }),
    });

    const publisher = new MetaPublisherAdapter({
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      publisher.publishFacebook({
        pageId: "page_123",
        accessToken: secretToken,
        caption: "Legenda",
      }),
    ).rejects.toThrow(MetaPermissionError);
  });

  it("converte erro de rate limit (4, 17, 32) em MetaRateLimitError", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: "(#32) Page request limit reached",
          type: "OAuthException",
          code: 32,
        },
      }),
    });

    const publisher = new MetaPublisherAdapter({
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      publisher.publishFacebook({
        pageId: "page_123",
        accessToken: secretToken,
        caption: "Legenda",
      }),
    ).rejects.toThrow(MetaRateLimitError);
  });

  it("garante ausência total de tokens em URLs, parâmetros de busca ou corpos, e envia Authorization: Bearer", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        // Valida URL
        expect(url).not.toContain(secretToken);
        expect(url).not.toContain("access_token");

        // Valida Cabeçalho
        const headers = init?.headers as Record<string, string>;
        expect(headers).toBeDefined();
        expect(headers["Authorization"]).toBe(`Bearer ${secretToken}`);

        // Valida Corpo (se houver)
        if (init?.body) {
          const bodyStr = String(init.body);
          expect(bodyStr).not.toContain(secretToken);
          expect(bodyStr).not.toContain("access_token");
        }

        if (url.includes("/photos")) {
          return {
            ok: true,
            json: async () => ({ id: "p1", post_id: "p1_post" }),
          };
        }
        if (url.includes("/media") && !url.includes("media_publish")) {
          return {
            ok: true,
            json: async () => ({ id: "c1" }),
          };
        }
        if (url.includes("status_code")) {
          return {
            ok: true,
            json: async () => ({ status_code: "FINISHED" }),
          };
        }
        if (url.includes("/media_publish")) {
          return {
            ok: true,
            json: async () => ({ id: "ig_pub1" }),
          };
        }
        if (url.includes("permalink")) {
          return {
            ok: true,
            json: async () => ({ permalink: "https://ig.me/p/1" }),
          };
        }
        return { ok: true, json: async () => ({ id: "fb_feed1" }) };
      });

    const publisher = new MetaPublisherAdapter({
      fetchFn: mockFetch as unknown as typeof fetch,
      pollDelayMs: 5,
    });

    // 1. Facebook com foto
    await publisher.publishFacebook({
      pageId: "fb_p1",
      accessToken: secretToken,
      caption: "Foto",
      imageUrl: "https://example.com/img.jpg",
    });

    // 2. Facebook texto
    await publisher.publishFacebook({
      pageId: "fb_p1",
      accessToken: secretToken,
      caption: "Texto",
    });

    // 3. Instagram completo
    await publisher.publishInstagram({
      igUserId: "ig_u1",
      accessToken: secretToken,
      imageUrl: "https://example.com/img.jpg",
      caption: "IG",
    });

    // Todas as chamadas foram inspecionadas nas asserções acima
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it("retoma publicação no Instagram com container existente FINISHED sem criar outro", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      // Não deve chamar a criação (/media)
      if (url.includes("/ig_user_1/media") && !url.includes("media_publish")) {
        throw new Error("Não deveria ter chamado createInstagramContainer!");
      }
      // Consulta status do container anterior
      if (url.includes("existing_container_777")) {
        return {
          ok: true,
          json: async () => ({ status_code: "FINISHED" }),
        };
      }
      // Publicação do container
      if (url.includes("/media_publish")) {
        return {
          ok: true,
          json: async () => ({ id: "ig_resumed_media_999" }),
        };
      }
      // Permalink
      return {
        ok: true,
        json: async () => ({ permalink: "https://instagram.com/p/resumed" }),
      };
    });

    const publisher = new MetaPublisherAdapter({
      fetchFn: mockFetch as unknown as typeof fetch,
      pollDelayMs: 5,
    });

    const containerCreatedSpy = vi.fn();

    const result = await publisher.publishInstagram(
      {
        igUserId: "ig_user_1",
        accessToken: secretToken,
        imageUrl: "https://example.com/img.jpg",
        caption: "Resumed",
      },
      {
        existingContainerId: "existing_container_777",
        onContainerCreated: containerCreatedSpy,
      },
    );

    // Não deve ter criado outro container
    expect(containerCreatedSpy).not.toHaveBeenCalled();
    expect(result.creationContainerId).toBe("existing_container_777");
    expect(result.remoteMediaId).toBe("ig_resumed_media_999");
    expect(result.remotePermalink).toBe("https://instagram.com/p/resumed");
  });

  it("recria container no Instagram se o container anterior estiver EXPIRED ou com ERROR", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      // Consulta status do container anterior -> expirado
      if (url.includes("expired_container_111")) {
        return {
          ok: true,
          json: async () => ({ status_code: "EXPIRED" }),
        };
      }
      // Criação de novo container
      if (url.includes("/ig_user_1/media") && !url.includes("media_publish")) {
        return {
          ok: true,
          json: async () => ({ id: "brand_new_container_222" }),
        };
      }
      // Consulta status do novo container
      if (url.includes("brand_new_container_222")) {
        return {
          ok: true,
          json: async () => ({ status_code: "FINISHED" }),
        };
      }
      // Publicação
      if (url.includes("/media_publish")) {
        return {
          ok: true,
          json: async () => ({ id: "ig_new_published_333" }),
        };
      }
      return {
        ok: true,
        json: async () => ({ permalink: "https://instagram.com/p/new" }),
      };
    });

    const publisher = new MetaPublisherAdapter({
      fetchFn: mockFetch as unknown as typeof fetch,
      pollDelayMs: 5,
    });

    const containerCreatedSpy = vi.fn();

    const result = await publisher.publishInstagram(
      {
        igUserId: "ig_user_1",
        accessToken: secretToken,
        imageUrl: "https://example.com/img.jpg",
        caption: "New after expired",
      },
      {
        existingContainerId: "expired_container_111",
        onContainerCreated: containerCreatedSpy,
      },
    );

    expect(containerCreatedSpy).toHaveBeenCalledWith("brand_new_container_222");
    expect(result.creationContainerId).toBe("brand_new_container_222");
    expect(result.remoteMediaId).toBe("ig_new_published_333");
  });
});
