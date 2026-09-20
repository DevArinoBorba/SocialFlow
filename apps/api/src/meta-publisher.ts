export class MetaPublishError extends Error {
  constructor(
    message: string,
    public readonly code?: number | string,
    public readonly subcode?: number | string,
    public readonly errorType?: string,
  ) {
    super(message);
    this.name = "MetaPublishError";
  }
}

export class MetaAuthError extends MetaPublishError {
  constructor(
    message: string,
    code?: number | string,
    subcode?: number | string,
  ) {
    super(message, code, subcode, "OAuthException");
    this.name = "MetaAuthError";
  }
}

export class MetaMediaError extends MetaPublishError {
  constructor(
    message: string,
    code?: number | string,
    subcode?: number | string,
  ) {
    super(message, code, subcode, "MediaException");
    this.name = "MetaMediaError";
  }
}

export class MetaPermissionError extends MetaPublishError {
  constructor(
    message: string,
    code?: number | string,
    subcode?: number | string,
  ) {
    super(message, code, subcode, "PermissionException");
    this.name = "MetaPermissionError";
  }
}

export class MetaRateLimitError extends MetaPublishError {
  constructor(
    message: string,
    code?: number | string,
    subcode?: number | string,
  ) {
    super(message, code, subcode, "RateLimitException");
    this.name = "MetaRateLimitError";
  }
}

export class MetaTimeoutError extends MetaPublishError {
  constructor(message: string) {
    super(
      message,
      "CONTAINER_PROCESSING_TIMEOUT",
      undefined,
      "TimeoutException",
    );
    this.name = "MetaTimeoutError";
  }
}

export interface MetaPublisherOptions {
  graphBaseUrl?: string;
  graphVersion?: string;
  fetchFn?: typeof fetch;
  pollDelayMs?: number;
  pollMaxAttempts?: number;
}

export interface FacebookPublishParams {
  pageId: string;
  accessToken: string;
  caption: string;
  imageUrl?: string | null;
}

export interface InstagramContainerParams {
  igUserId: string;
  accessToken: string;
  imageUrl: string;
  caption: string;
}

export interface PublishResult {
  remoteMediaId: string;
  remotePermalink: string | null;
  creationContainerId?: string;
}

/**
 * Sanitizes any string to ensure access tokens and secrets are never leaked in errors or logs.
 */
function sanitizeMessage(msg: string, tokenToScrub?: string): string {
  let cleaned = msg.replace(
    /access_token=[^&"\s]+/gi,
    "access_token=[REDACTED]",
  );
  if (tokenToScrub && tokenToScrub.length > 5) {
    cleaned = cleaned.replaceAll(tokenToScrub, "[REDACTED]");
  }
  return cleaned;
}

export class MetaPublisherAdapter {
  private readonly graphBaseUrl: string;
  private readonly graphVersion: string;
  private readonly fetchFn: typeof fetch;
  private readonly pollDelayMs: number;
  private readonly pollMaxAttempts: number;

  constructor(options: MetaPublisherOptions = {}) {
    this.graphBaseUrl = (
      options.graphBaseUrl || "https://graph.facebook.com"
    ).replace(/\/+$/, "");
    this.graphVersion = options.graphVersion || "v21.0";
    this.fetchFn = options.fetchFn || fetch;
    this.pollDelayMs = options.pollDelayMs ?? 2000;
    this.pollMaxAttempts = options.pollMaxAttempts ?? 10;
  }

  private parseMetaError(
    errJson: {
      error?: {
        message?: string;
        code?: number;
        error_subcode?: number;
        type?: string;
      };
    },
    tokenToScrub?: string,
  ): MetaPublishError {
    const err = errJson.error || {};
    const rawMsg =
      err.message || "Erro desconhecido retornado pela Meta Graph API.";
    const message = sanitizeMessage(rawMsg, tokenToScrub);
    const code = err.code;
    const subcode = err.error_subcode;

    // Erros de autenticação / token revogado / expirado (190)
    if (code === 190) {
      return new MetaAuthError(
        `Token da Meta expirado ou revogado. Reconecte a conta: ${message}`,
        code,
        subcode,
      );
    }

    // Erros de permissão (200, 298, etc.)
    if (
      code === 200 ||
      code === 298 ||
      err.type === "OAuthPermissionsException"
    ) {
      return new MetaPermissionError(
        `Permissão insuficiente na Meta: ${message}`,
        code,
        subcode,
      );
    }

    // Erros de mídia (36003, 2207001, 2207009, etc.)
    if (
      code === 36003 ||
      code === 2207001 ||
      code === 2207009 ||
      code === 2207023 ||
      rawMsg.toLowerCase().includes("aspect ratio") ||
      rawMsg.toLowerCase().includes("media")
    ) {
      return new MetaMediaError(
        `Mídia rejeitada pela Meta: ${message}`,
        code,
        subcode,
      );
    }

    // Erros de rate limit (4, 17, 32, 613)
    if (code === 4 || code === 17 || code === 32 || code === 613) {
      return new MetaRateLimitError(
        `Limite de requisições excedido na Meta. Tente novamente mais tarde.`,
        code,
        subcode,
      );
    }

    return new MetaPublishError(message, code, subcode, err.type);
  }

  /**
   * Publica foto com legenda ou post de texto em uma Página do Facebook.
   */
  async publishFacebook(params: FacebookPublishParams): Promise<PublishResult> {
    const { pageId, accessToken, caption, imageUrl } = params;

    if (imageUrl) {
      // Publicação de Foto com Legenda
      const url = `${this.graphBaseUrl}/${this.graphVersion}/${encodeURIComponent(pageId)}/photos`;
      const formData = new URLSearchParams();
      formData.set("url", imageUrl);
      formData.set("caption", caption);
      formData.set("access_token", accessToken);

      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formData.toString(),
        });
      } catch (networkError) {
        throw new MetaPublishError(
          `Falha de conexão com a Meta: ${sanitizeMessage((networkError as Error).message, accessToken)}`,
        );
      }

      const json = await response.json().catch(() => ({}));

      if (!response.ok || json.error) {
        throw this.parseMetaError(json, accessToken);
      }

      const photoId = String(json.id);
      const postId = json.post_id ? String(json.post_id) : photoId;
      const permalink = `https://www.facebook.com/${postId}`;

      return {
        remoteMediaId: postId,
        remotePermalink: permalink,
      };
    } else {
      // Publicação somente texto via /feed
      const url = `${this.graphBaseUrl}/${this.graphVersion}/${encodeURIComponent(pageId)}/feed`;
      const formData = new URLSearchParams();
      formData.set("message", caption);
      formData.set("access_token", accessToken);

      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formData.toString(),
        });
      } catch (networkError) {
        throw new MetaPublishError(
          `Falha de conexão com a Meta: ${sanitizeMessage((networkError as Error).message, accessToken)}`,
        );
      }

      const json = await response.json().catch(() => ({}));

      if (!response.ok || json.error) {
        throw this.parseMetaError(json, accessToken);
      }

      const postId = String(json.id);
      const permalink = `https://www.facebook.com/${postId}`;

      return {
        remoteMediaId: postId,
        remotePermalink: permalink,
      };
    }
  }

  /**
   * Cria um container de mídia no Instagram.
   */
  async createInstagramContainer(
    params: InstagramContainerParams,
  ): Promise<{ containerId: string }> {
    const { igUserId, accessToken, imageUrl, caption } = params;

    const url = `${this.graphBaseUrl}/${this.graphVersion}/${encodeURIComponent(igUserId)}/media`;
    const formData = new URLSearchParams();
    formData.set("image_url", imageUrl);
    formData.set("caption", caption);
    formData.set("access_token", accessToken);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });
    } catch (networkError) {
      throw new MetaPublishError(
        `Falha ao conectar com o Instagram: ${sanitizeMessage((networkError as Error).message, accessToken)}`,
      );
    }

    const json = await response.json().catch(() => ({}));

    if (!response.ok || json.error) {
      throw this.parseMetaError(json, accessToken);
    }

    if (!json.id) {
      throw new MetaPublishError(
        "Instagram não retornou ID de container de mídia.",
      );
    }

    return { containerId: String(json.id) };
  }

  /**
   * Consulta o status de processamento do container do Instagram.
   */
  async checkInstagramContainerStatus(
    containerId: string,
    accessToken: string,
  ): Promise<{
    statusCode: "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS";
    statusMessage?: string;
  }> {
    const url = `${this.graphBaseUrl}/${this.graphVersion}/${encodeURIComponent(containerId)}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, { method: "GET" });
    } catch (networkError) {
      throw new MetaPublishError(
        `Falha ao consultar status do container Instagram: ${sanitizeMessage((networkError as Error).message, accessToken)}`,
      );
    }

    const json = await response.json().catch(() => ({}));

    if (!response.ok || json.error) {
      throw this.parseMetaError(json, accessToken);
    }

    const statusCode = String(json.status_code || "").toUpperCase();
    if (
      statusCode === "FINISHED" ||
      statusCode === "IN_PROGRESS" ||
      statusCode === "EXPIRED" ||
      statusCode === "ERROR"
    ) {
      return {
        statusCode,
        statusMessage: json.status ? String(json.status) : undefined,
      };
    }

    // Default se não vier status_code explícito
    return { statusCode: "IN_PROGRESS" };
  }

  /**
   * Aguarda o container do Instagram atingir o status FINISHED com polling.
   */
  async pollInstagramContainer(
    containerId: string,
    accessToken: string,
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.pollMaxAttempts; attempt++) {
      const { statusCode, statusMessage } =
        await this.checkInstagramContainerStatus(containerId, accessToken);

      if (statusCode === "FINISHED") {
        return;
      }

      if (statusCode === "ERROR") {
        throw new MetaMediaError(
          `Processamento de mídia no Instagram falhou: ${statusMessage || "Erro no processamento da imagem"}`,
        );
      }

      if (statusCode === "EXPIRED") {
        throw new MetaPublishError(
          "Container de mídia do Instagram expirou antes da publicação.",
        );
      }

      // Se atingiu o número máximo de tentativas sem concluir
      if (attempt === this.pollMaxAttempts) {
        throw new MetaTimeoutError(
          `Tempo limite esgotado (${this.pollMaxAttempts * (this.pollDelayMs / 1000)}s) aguardando processamento da mídia pelo Instagram.`,
        );
      }

      // Aguarda antes da próxima consulta
      await new Promise((resolve) => setTimeout(resolve, this.pollDelayMs));
    }
  }

  /**
   * Executa a publicação final do container no Instagram (media_publish).
   */
  async publishInstagramContainer(
    igUserId: string,
    accessToken: string,
    containerId: string,
  ): Promise<{ remoteMediaId: string; remotePermalink: string | null }> {
    const url = `${this.graphBaseUrl}/${this.graphVersion}/${encodeURIComponent(igUserId)}/media_publish`;
    const formData = new URLSearchParams();
    formData.set("creation_id", containerId);
    formData.set("access_token", accessToken);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });
    } catch (networkError) {
      throw new MetaPublishError(
        `Falha ao publicar container no Instagram: ${sanitizeMessage((networkError as Error).message, accessToken)}`,
      );
    }

    const json = await response.json().catch(() => ({}));

    if (!response.ok || json.error) {
      throw this.parseMetaError(json, accessToken);
    }

    const remoteMediaId = String(json.id);

    // Tenta obter o permalink público do Instagram
    let remotePermalink: string | null = null;
    try {
      const permalinkUrl = `${this.graphBaseUrl}/${this.graphVersion}/${encodeURIComponent(remoteMediaId)}?fields=permalink&access_token=${encodeURIComponent(accessToken)}`;
      const permalinkRes = await this.fetchFn(permalinkUrl, { method: "GET" });
      if (permalinkRes.ok) {
        const permalinkJson = await permalinkRes.json().catch(() => ({}));
        if (permalinkJson.permalink) {
          remotePermalink = String(permalinkJson.permalink);
        }
      }
    } catch {
      // Falha não crítica para a publicação
    }

    return {
      remoteMediaId,
      remotePermalink,
    };
  }

  /**
   * Orquestra o ciclo completo de publicação no Instagram:
   * 1. Criar container
   * 2. Polling até FINISHED
   * 3. Publicar container
   */
  async publishInstagram(
    params: InstagramContainerParams,
    onContainerCreated?: (containerId: string) => Promise<void> | void,
  ): Promise<PublishResult> {
    const { containerId } = await this.createInstagramContainer(params);

    if (onContainerCreated) {
      await onContainerCreated(containerId);
    }

    await this.pollInstagramContainer(containerId, params.accessToken);

    const { remoteMediaId, remotePermalink } =
      await this.publishInstagramContainer(
        params.igUserId,
        params.accessToken,
        containerId,
      );

    return {
      remoteMediaId,
      remotePermalink,
      creationContainerId: containerId,
    };
  }
}
