import { describe, expect, it } from "vitest";
import {
  createSignedMediaToken,
  verifySignedMediaToken,
  type SignedMediaPayload,
} from "../../apps/api/src/media-token.js";

describe("Signed Media Token Unit Tests", () => {
  const secret = "test_session_secret_with_adequate_length_12345";
  const payload: SignedMediaPayload = {
    organizationId: "org-1",
    clientId: "client-1",
    mediaId: "media-uuid-1",
    storageKey: "media/org-1/client-1/file.jpg",
    mimeType: "image/jpeg",
    byteSize: 1024,
    sha256: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    expiresAt: Date.now() + 60000,
  };

  it("gera e verifica com sucesso um token assinado válido", () => {
    const token = createSignedMediaToken(secret, payload);
    expect(typeof token).toBe("string");
    expect(token).toContain(".");

    const verified = verifySignedMediaToken(secret, token);
    expect(verified).not.toBeNull();
    expect(verified?.organizationId).toBe("org-1");
    expect(verified?.clientId).toBe("client-1");
    expect(verified?.mediaId).toBe("media-uuid-1");
    expect(verified?.storageKey).toBe("media/org-1/client-1/file.jpg");
    expect(verified?.mimeType).toBe("image/jpeg");
    expect(verified?.sha256).toBe(payload.sha256);
  });

  it("rejeita token adulterado (tampered data)", () => {
    const token = createSignedMediaToken(secret, payload);
    const [, sig] = token.split(".");
    // Modifica o dado base64
    const tamperedData = Buffer.from(
      JSON.stringify({ ...payload, mediaId: "tampered-id" }),
    ).toString("base64url");
    const tamperedToken = `${tamperedData}.${sig}`;

    const verified = verifySignedMediaToken(secret, tamperedToken);
    expect(verified).toBeNull();
  });

  it("rejeita token assinado com segredo diferente", () => {
    const token = createSignedMediaToken("different_secret_key_67890", payload);
    const verified = verifySignedMediaToken(secret, token);
    expect(verified).toBeNull();
  });

  it("rejeita token expirado", () => {
    const expiredPayload: SignedMediaPayload = {
      ...payload,
      expiresAt: Date.now() - 1000, // expirou há 1 segundo
    };
    const token = createSignedMediaToken(secret, expiredPayload);
    const verified = verifySignedMediaToken(secret, token);
    expect(verified).toBeNull();
  });

  it("rejeita formato de token malformado", () => {
    expect(verifySignedMediaToken(secret, "")).toBeNull();
    expect(verifySignedMediaToken(secret, "no-dot-token")).toBeNull();
    expect(verifySignedMediaToken(secret, "one.two.three")).toBeNull();
  });
});
