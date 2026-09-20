import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

export interface OpaqueMediaTicketData {
  organizationId: string;
  clientId: string;
  mediaId: string;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

export const MEDIA_TICKET_TTL_SECONDS = 3600; // 60 minutos (tempo hábil para container + polling + retentativas da Meta)
const TICKET_PREFIX = "socialflow:media-ticket:";

/**
 * Cria um identificador opaco criptograficamente seguro (256 bits de entropia)
 * e armazena os metadados necessários para localização e validação da mídia no Redis com TTL.
 */
export async function createPublicMediaTicket(
  redis: Redis,
  data: OpaqueMediaTicketData,
  ttlSeconds = MEDIA_TICKET_TTL_SECONDS,
): Promise<string> {
  // 32 bytes aleatórios em hexadecimal = 64 caracteres totalmente opacos
  const ticketId = randomBytes(32).toString("hex");
  const key = `${TICKET_PREFIX}${ticketId}`;
  await redis.set(key, JSON.stringify(data), "EX", ttlSeconds);
  return ticketId;
}

/**
 * Recupera os metadados da mídia associados ao identificador opaco.
 * Consumo estritamente somente para leitura: não deleta a chave, pois a Meta
 * pode realizar múltiplos downloads da mesma imagem durante criação e processamento.
 */
export async function getPublicMediaTicket(
  redis: Redis,
  ticketId: string,
): Promise<OpaqueMediaTicketData | null> {
  if (typeof ticketId !== "string" || !/^[a-f0-9]{64}$/.test(ticketId)) {
    return null;
  }
  const key = `${TICKET_PREFIX}${ticketId}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as OpaqueMediaTicketData;
    if (
      !data.storageKey ||
      !data.mimeType ||
      typeof data.byteSize !== "number" ||
      !data.sha256
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
