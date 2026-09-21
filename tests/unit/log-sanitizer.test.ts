import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "../../apps/api/src/log-sanitizer.js";

describe("log-sanitizer: sanitizeErrorMessage", () => {
  it("sanitiza URL Redis com senha", () => {
    const raw =
      "Connection failed to redis://:super_secret_pw@10.0.0.1:6379/0 during enqueue";
    const sanitized = sanitizeErrorMessage(raw);
    expect(sanitized).not.toContain("super_secret_pw");
    expect(sanitized).not.toContain("10.0.0.1");
    expect(sanitized).toContain("[REDACTED_REDIS_URL]");

    const redissRaw =
      "Cluster error: rediss://admin:another_pwd@redis.prod.internal:6380/2 timeout";
    const redissSanitized = sanitizeErrorMessage(redissRaw);
    expect(redissSanitized).not.toContain("another_pwd");
    expect(redissSanitized).not.toContain("redis.prod.internal");
    expect(redissSanitized).toContain("[REDACTED_REDIS_URL]");
  });

  it("sanitiza URL PostgreSQL", () => {
    const raw =
      "DB pool error at postgresql://social_user:db_secret_pass@127.0.0.1:5432/socialflow";
    const sanitized = sanitizeErrorMessage(raw);
    expect(sanitized).not.toContain("db_secret_pass");
    expect(sanitized).not.toContain("social_user");
    expect(sanitized).toContain("[REDACTED_DB_URL]");

    const shortRaw =
      "Connection closed: postgres://user:secret123@db.cloud.lan:5432/db";
    const shortSanitized = sanitizeErrorMessage(shortRaw);
    expect(shortSanitized).not.toContain("secret123");
    expect(shortSanitized).not.toContain("db.cloud.lan");
    expect(shortSanitized).toContain("[REDACTED_DB_URL]");
  });

  it("sanitiza URL HTTP privada", () => {
    const raw =
      "Failed to fetch internal endpoint http://10.0.1.50:8080/internal/credentials";
    const sanitized = sanitizeErrorMessage(raw);
    expect(sanitized).not.toContain("10.0.1.50");
    expect(sanitized).not.toContain("/internal/credentials");
    expect(sanitized).toContain("[REDACTED_URL]");

    const httpsRaw =
      "Gateway error at https://192.168.0.100:8443/private/vault/keys";
    const httpsSanitized = sanitizeErrorMessage(httpsRaw);
    expect(httpsSanitized).not.toContain("192.168.0.100");
    expect(httpsSanitized).not.toContain("/private/vault/keys");
    expect(httpsSanitized).toContain("[REDACTED_URL]");
  });

  it("sanitiza token Bearer", () => {
    const raw =
      "Request rejected for Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";
    const sanitized = sanitizeErrorMessage(raw);
    expect(sanitized).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(sanitized).toContain("Bearer [REDACTED]");

    const rawSimple = "Token invalid: Bearer secret-auth-token-12345=";
    const sanitizedSimple = sanitizeErrorMessage(rawSimple);
    expect(sanitizedSimple).not.toContain("secret-auth-token-12345");
    expect(sanitizedSimple).toContain("Bearer [REDACTED]");
  });

  it("sanitiza segredo hexadecimal (32 e 64 caracteres)", () => {
    const hex32 = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const hex64 =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const raw32 = `HMAC secret mismatch for key ${hex32}`;
    const sanitized32 = sanitizeErrorMessage(raw32);
    expect(sanitized32).not.toContain(hex32);
    expect(sanitized32).toContain("[REDACTED_SECRET]");

    const raw64 = `Secret hash=${hex64} verification failed`;
    const sanitized64 = sanitizeErrorMessage(raw64);
    expect(sanitized64).not.toContain(hex64);
    expect(sanitized64).toContain("[REDACTED_SECRET]");
  });

  it("preserva UUIDs válidos e trunca mensagens longas em 250 caracteres", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const raw = `Job ${uuid} failed with unexpected reason`;
    const sanitized = sanitizeErrorMessage(raw);
    expect(sanitized).toContain(uuid);

    const longMessage =
      "Erro inesperado ao processar mensagem com texto longo normal. ".repeat(
        10,
      );
    const sanitizedLong = sanitizeErrorMessage(longMessage);
    expect(sanitizedLong.length).toBeLessThanOrEqual(250);
    expect(sanitizedLong.endsWith("...")).toBe(true);
  });

  it("trata Error objects e entradas vazias ou não-string de forma segura", () => {
    expect(sanitizeErrorMessage(new Error("redis://:pw@10.0.0.1:6379/0"))).toBe(
      "[REDACTED_REDIS_URL]",
    );
    expect(sanitizeErrorMessage(null)).toBe("Erro desconhecido");
    expect(sanitizeErrorMessage(undefined)).toBe("Erro desconhecido");
    expect(sanitizeErrorMessage("")).toBe("Erro desconhecido");
    expect(sanitizeErrorMessage("   ")).toBe("Erro desconhecido");
  });
});
