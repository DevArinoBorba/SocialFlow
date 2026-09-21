export function sanitizeErrorMessage(message: unknown): string {
  const raw =
    message instanceof Error
      ? message.message
      : typeof message === "string"
        ? message
        : "";
  if (!raw || !raw.trim()) return "Erro desconhecido";
  let clean = raw
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(/EAA[A-Za-z0-9]+/g, "[REDACTED_META_TOKEN]")
    .replace(/rediss?:\/\/[^\s"';)>]+/gi, "[REDACTED_REDIS_URL]")
    .replace(/postgres(?:ql)?:\/\/[^\s"';)>]+/gi, "[REDACTED_DB_URL]")
    .replace(/[0-9a-fA-F]{32,}/g, "[REDACTED_SECRET]")
    .replace(/https?:\/\/[^\s"';)>]+/gi, "[REDACTED_URL]");
  if (clean.length > 250) {
    clean = clean.slice(0, 247) + "...";
  }
  return clean;
}
