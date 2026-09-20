import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import {
  createPublicMediaTicket,
  getPublicMediaTicket,
  MEDIA_TICKET_TTL_SECONDS,
  type OpaqueMediaTicketData,
} from "../../apps/api/src/media-ticket.js";

describe("Opaque Media Ticket Unit Tests", () => {
  const sampleData: OpaqueMediaTicketData = {
    organizationId: "org-1",
    clientId: "client-1",
    mediaId: "media-uuid-1",
    storageKey: "media/org-1/client-1/photo.jpg",
    mimeType: "image/jpeg",
    byteSize: 2048,
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };

  it("gera ticket criptograficamente seguro, opaco de 64 caracteres hexadecimais com TTL de 3600s", async () => {
    const memoryStore = new Map<string, { value: string; ex: number }>();
    const mockRedis = {
      set: vi.fn(
        async (key: string, value: string, mode: string, ex: number) => {
          expect(mode).toBe("EX");
          expect(ex).toBe(MEDIA_TICKET_TTL_SECONDS);
          memoryStore.set(key, { value, ex });
          return "OK";
        },
      ),
      get: vi.fn(async (key: string) => memoryStore.get(key)?.value ?? null),
    } as unknown as Redis;

    const ticketId = await createPublicMediaTicket(mockRedis, sampleData);

    // Deve ter exatamente 64 caracteres hexadecimais (256 bits de entropia)
    expect(ticketId).toMatch(/^[a-f0-9]{64}$/);
    // Não deve vazar caminhos de storage ou IDs no identificador público
    expect(ticketId).not.toContain("org-1");
    expect(ticketId).not.toContain("client-1");
    expect(ticketId).not.toContain("photo.jpg");
    expect(ticketId).not.toContain("media");

    // Gravado no Redis com prefixo e dados íntegros
    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const key = `socialflow:media-ticket:${ticketId}`;
    expect(memoryStore.has(key)).toBe(true);

    const retrieved = await getPublicMediaTicket(mockRedis, ticketId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.storageKey).toBe(sampleData.storageKey);
    expect(retrieved?.mimeType).toBe(sampleData.mimeType);
    expect(retrieved?.byteSize).toBe(sampleData.byteSize);
    expect(retrieved?.sha256).toBe(sampleData.sha256);
  });

  it("permite múltiplos downloads legítimos da mesma mídia dentro do TTL (não deleta no get)", async () => {
    const memoryStore = new Map<string, string>();
    const mockRedis = {
      set: vi.fn(async (key: string, value: string) => {
        memoryStore.set(key, value);
        return "OK";
      }),
      get: vi.fn(async (key: string) => memoryStore.get(key) ?? null),
      del: vi.fn(),
    } as unknown as Redis;

    const ticketId = await createPublicMediaTicket(mockRedis, sampleData);

    // 1ª leitura pela Meta (para validação)
    const read1 = await getPublicMediaTicket(mockRedis, ticketId);
    expect(read1).not.toBeNull();
    expect(read1?.sha256).toBe(sampleData.sha256);

    // 2ª leitura pela Meta (para renderização / container)
    const read2 = await getPublicMediaTicket(mockRedis, ticketId);
    expect(read2).not.toBeNull();
    expect(read2?.storageKey).toBe(sampleData.storageKey);

    // 3ª leitura por retentativa
    const read3 = await getPublicMediaTicket(mockRedis, ticketId);
    expect(read3).not.toBeNull();

    // del não deve ter sido chamado para leitura
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it("rejeita e retorna null para ticket adulterado, malformado ou inexistente", async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),
    } as unknown as Redis;

    // Formato inválido: tamanho menor
    expect(await getPublicMediaTicket(mockRedis, "abc1234")).toBeNull();
    // Formato inválido: caracteres fora de hex
    expect(
      await getPublicMediaTicket(
        mockRedis,
        "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      ),
    ).toBeNull();
    // Vazio
    expect(await getPublicMediaTicket(mockRedis, "")).toBeNull();
    // Tipo incorreto
    expect(
      await getPublicMediaTicket(mockRedis, null as unknown as string),
    ).toBeNull();

    // Formato hex 64 válido mas não existente no Redis (expirado)
    const validHexNonExistent = "a".repeat(64);
    const result = await getPublicMediaTicket(mockRedis, validHexNonExistent);
    expect(result).toBeNull();
  });
});
