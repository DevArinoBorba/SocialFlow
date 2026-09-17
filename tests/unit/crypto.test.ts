import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createCredentialCrypto,
  createKeyringCredentialCrypto,
  CryptoError,
  type CredentialContext,
} from "../../packages/db/src/crypto.js";

const VALID_KEY_32 = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const VALID_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WRONG_KEY_32 = Buffer.from("fedcba9876543210fedcba9876543210", "utf8");

const validContext: CredentialContext = {
  organizationId: "org_alpha_123",
  clientId: "client_bravo_456",
  platformAccountId: "act_fb_page_789",
  keyVersion: 1,
};

describe("AES-256-GCM Credential Crypto", () => {
  describe("key validation", () => {
    it("accepts a valid 32-byte Buffer", () => {
      expect(() => createCredentialCrypto(VALID_KEY_32)).not.toThrow();
    });

    it("accepts a valid 64-char hex string", () => {
      expect(() => createCredentialCrypto(VALID_KEY_HEX)).not.toThrow();
    });

    it("rejects keys with invalid lengths", () => {
      expect(() => createCredentialCrypto(Buffer.alloc(16))).toThrow(
        CryptoError,
      );
      expect(() => createCredentialCrypto(Buffer.alloc(31))).toThrow(
        CryptoError,
      );
      expect(() => createCredentialCrypto(Buffer.alloc(33))).toThrow(
        CryptoError,
      );
      expect(() => createCredentialCrypto("too-short")).toThrow(CryptoError);
    });

    it("rejects invalid key types", () => {
      // @ts-expect-error test runtime validation
      expect(() => createCredentialCrypto(12345)).toThrow(CryptoError);
    });
  });

  describe("encryption and decryption round-trip", () => {
    it("successfully encrypts and decrypts access token with Buffer key", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      const secret = "EAABwzLixnjYBO123456789secret_access_token";

      const payload = crypto.encrypt(secret, validContext);
      expect(payload.encryptedAccessToken).toBeDefined();
      expect(payload.iv).toBeDefined();
      expect(payload.authTag).toBeDefined();
      expect(payload.keyVersion).toBe(1);

      const decrypted = crypto.decrypt(payload, validContext);
      expect(decrypted).toBe(secret);
    });

    it("successfully encrypts and decrypts with hex-encoded key", () => {
      const crypto = createCredentialCrypto(VALID_KEY_HEX);
      const secret = "EAABwzLixnjYBO987654321another_secret_token";

      const payload = crypto.encrypt(secret, validContext);
      const decrypted = crypto.decrypt(payload, validContext);
      expect(decrypted).toBe(secret);
    });

    it("handles arbitrary unicode strings and large tokens", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      const secret = "Token Com Acentuação & Emojis 🚀🔐 " + "A".repeat(1024);

      const payload = crypto.encrypt(secret, validContext);
      const decrypted = crypto.decrypt(payload, validContext);
      expect(decrypted).toBe(secret);
    });

    it("produces distinct IV and ciphertext for identical plaintexts (non-deterministic)", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      const secret = "same_secret_token_twice";

      const p1 = crypto.encrypt(secret, validContext);
      const p2 = crypto.encrypt(secret, validContext);

      expect(p1.iv).not.toBe(p2.iv);
      expect(p1.encryptedAccessToken).not.toBe(p2.encryptedAccessToken);
      expect(crypto.decrypt(p1, validContext)).toBe(secret);
      expect(crypto.decrypt(p2, validContext)).toBe(secret);
    });

    it("rejects empty plaintext", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      expect(() => crypto.encrypt("", validContext)).toThrow(CryptoError);
    });
  });

  describe("adulteração / tampering detection", () => {
    it("fails when ciphertext is altered", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      const payload = crypto.encrypt("my_access_token", validContext);

      const raw = Buffer.from(payload.encryptedAccessToken, "base64");
      raw[0] = (raw[0] ?? 0) ^ 0x01; // flip 1 bit
      const tamperedPayload = {
        ...payload,
        encryptedAccessToken: raw.toString("base64"),
      };

      expect(() => crypto.decrypt(tamperedPayload, validContext)).toThrow(
        CryptoError,
      );
    });

    it("fails when IV is altered", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      const payload = crypto.encrypt("my_access_token", validContext);

      const rawIv = Buffer.from(payload.iv, "base64");
      rawIv[0] = (rawIv[0] ?? 0) ^ 0xff;
      const tamperedPayload = {
        ...payload,
        iv: rawIv.toString("base64"),
      };

      expect(() => crypto.decrypt(tamperedPayload, validContext)).toThrow(
        CryptoError,
      );
    });

    it("fails when authTag is altered", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      const payload = crypto.encrypt("my_access_token", validContext);

      const rawTag = Buffer.from(payload.authTag, "base64");
      rawTag[0] = (rawTag[0] ?? 0) ^ 0x55;
      const tamperedPayload = {
        ...payload,
        authTag: rawTag.toString("base64"),
      };

      expect(() => crypto.decrypt(tamperedPayload, validContext)).toThrow(
        CryptoError,
      );
    });

    it("fails on invalid IV length", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      const payload = crypto.encrypt("my_access_token", validContext);

      const tamperedPayload = {
        ...payload,
        iv: randomBytes(8).toString("base64"),
      };

      expect(() => crypto.decrypt(tamperedPayload, validContext)).toThrow(
        CryptoError,
      );
    });

    it("fails on invalid authTag length", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      const payload = crypto.encrypt("my_access_token", validContext);

      const tamperedPayload = {
        ...payload,
        authTag: randomBytes(8).toString("base64"),
      };

      expect(() => crypto.decrypt(tamperedPayload, validContext)).toThrow(
        CryptoError,
      );
    });

    it("fails on missing payload fields", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      // @ts-expect-error test malformed payload
      expect(() => crypto.decrypt({}, validContext)).toThrow(CryptoError);
    });
  });

  describe("chave incorreta / wrong key", () => {
    it("fails when decrypting with a different 32-byte master key", () => {
      const cryptoA = createCredentialCrypto(VALID_KEY_32);
      const cryptoB = createCredentialCrypto(WRONG_KEY_32);

      const payload = cryptoA.encrypt("sensitive_token", validContext);

      expect(() => cryptoB.decrypt(payload, validContext)).toThrow(CryptoError);
    });
  });

  describe("isolamento por contexto (AAD mismatch)", () => {
    it("fails when organizationId differs between encryption and decryption", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      const payload = crypto.encrypt("tenant_token", validContext);

      const crossTenantContext: CredentialContext = {
        ...validContext,
        organizationId: "org_victim_999",
      };

      expect(() => crypto.decrypt(payload, crossTenantContext)).toThrow(
        CryptoError,
      );
    });

    it("fails when clientId differs between encryption and decryption", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      const payload = crypto.encrypt("tenant_token", validContext);

      const crossClientContext: CredentialContext = {
        ...validContext,
        clientId: "client_different_999",
      };

      expect(() => crypto.decrypt(payload, crossClientContext)).toThrow(
        CryptoError,
      );
    });

    it("fails when platformAccountId differs between encryption and decryption", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      const payload = crypto.encrypt("tenant_token", validContext);

      const crossAccountContext: CredentialContext = {
        ...validContext,
        platformAccountId: "act_fb_page_attacker",
      };

      expect(() => crypto.decrypt(payload, crossAccountContext)).toThrow(
        CryptoError,
      );
    });

    it("fails when keyVersion differs", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);
      const payload = crypto.encrypt("tenant_token", {
        ...validContext,
        keyVersion: 1,
      });

      const differentVersionContext: CredentialContext = {
        ...validContext,
        keyVersion: 2,
      };

      expect(() => crypto.decrypt(payload, differentVersionContext)).toThrow(
        CryptoError,
      );
    });

    it("rejects encryption or decryption when context has empty fields", () => {
      const crypto = createCredentialCrypto(VALID_KEY_32);

      expect(() =>
        crypto.encrypt("token", {
          ...validContext,
          organizationId: "",
        }),
      ).toThrow(CryptoError);

      expect(() =>
        crypto.encrypt("token", {
          ...validContext,
          clientId: "",
        }),
      ).toThrow(CryptoError);

      expect(() =>
        crypto.encrypt("token", {
          ...validContext,
          platformAccountId: "",
        }),
      ).toThrow(CryptoError);
    });
  });

  describe("rotação de chave e keyring", () => {
    const KEY_V1 = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
    const KEY_V2 = Buffer.from("fedcba9876543210fedcba9876543210", "utf8");
    const secret = "EAABwzLixnjYBO_very_secret_meta_token_value_999";

    it("executa migração e rotação manual de chave v1 para chave v2", () => {
      const cryptoV1 = createCredentialCrypto(KEY_V1, 1);
      const cryptoV2 = createCredentialCrypto(KEY_V2, 2);

      // Criptografa sob v1
      const payloadV1 = cryptoV1.encrypt(secret, {
        ...validContext,
        keyVersion: 1,
      });
      expect(payloadV1.keyVersion).toBe(1);

      // Decripta sob v1 e recriptografa sob v2
      const decryptedV1 = cryptoV1.decrypt(payloadV1, {
        ...validContext,
        keyVersion: 1,
      });
      expect(decryptedV1).toBe(secret);

      const payloadV2 = cryptoV2.encrypt(decryptedV1, {
        ...validContext,
        keyVersion: 2,
      });
      expect(payloadV2.keyVersion).toBe(2);

      // V1 não consegue decriptar V2; V2 decripta com sucesso
      expect(() =>
        cryptoV1.decrypt(payloadV2, { ...validContext, keyVersion: 2 }),
      ).toThrow(CryptoError);
      expect(
        cryptoV2.decrypt(payloadV2, { ...validContext, keyVersion: 2 }),
      ).toBe(secret);
    });

    it("suporta keyring multi-versão e rotate() atômico", () => {
      const contextAnyVersion: CredentialContext = {
        organizationId: validContext.organizationId,
        clientId: validContext.clientId,
        platformAccountId: validContext.platformAccountId,
      };

      const keyring = createKeyringCredentialCrypto({
        keys: {
          1: KEY_V1,
          2: KEY_V2,
        },
        activeVersion: 2,
      });

      // Criptografa especificando explicitamente v1
      const payloadV1 = keyring.encrypt(secret, {
        ...contextAnyVersion,
        keyVersion: 1,
      });
      expect(payloadV1.keyVersion).toBe(1);

      // Keyring consegue decriptar payload v1 mesmo com versão ativa em 2
      expect(keyring.decrypt(payloadV1, contextAnyVersion)).toBe(secret);

      // Rotaciona payload para a versão ativa (v2)
      const rotated = keyring.rotate(payloadV1, contextAnyVersion);
      expect(rotated.keyVersion).toBe(2);
      expect(keyring.decrypt(rotated, contextAnyVersion)).toBe(secret);
    });

    it("falha quando chave necessária para decriptação não existe no keyring", () => {
      const keyring = createKeyringCredentialCrypto({
        keys: {
          2: KEY_V2,
        },
        activeVersion: 2,
      });

      const payloadV1 = {
        encryptedAccessToken: "aW52YWxpZA==",
        iv: "MTIzNDU2Nzg5MDEy",
        authTag: "MTIzNDU2Nzg5MDEyMzQ1Ng==",
        keyVersion: 1,
      };

      expect(() => keyring.decrypt(payloadV1, validContext)).toThrow(
        "Key version 1 not found in keyring",
      );
    });

    it("valida obrigatoriedade da versão ativa no keyring", () => {
      expect(() =>
        createKeyringCredentialCrypto({
          keys: { 1: KEY_V1 },
          activeVersion: 3,
        }),
      ).toThrow("Active key version 3 is not present in the keyring");
    });
  });

  describe("ausência de segredos em mensagens de erro e logs (Defense-in-depth)", () => {
    it("não vaza o plaintext do token nem o material da chave em erros de falha de decriptação", () => {
      const secretToken = "EAABwzLixnjYBO_CRITICAL_SECRET_TOKEN_DO_NOT_LEAK";
      const crypto = createCredentialCrypto(VALID_KEY_32);
      const payload = crypto.encrypt(secretToken, validContext);

      // Corrompe o payload
      const tampered = {
        ...payload,
        encryptedAccessToken: Buffer.from("corrupted").toString("base64"),
      };

      try {
        crypto.decrypt(tampered, validContext);
        expect.fail("Deveria ter lançado CryptoError");
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoError);
        const errorMessage = (err as Error).message;
        const errorStack = (err as Error).stack ?? "";

        // Garante que o segredo nunca aparece nem na mensagem de erro nem no stack trace
        expect(errorMessage).not.toContain(secretToken);
        expect(errorStack).not.toContain(secretToken);
        expect(errorMessage).not.toContain("0123456789abcdef");
      }
    });

    it("não vaza chaves mestras inválidas quando rejeitadas", () => {
      const rawInvalidKey = "my-short-super-secret-password-attempt";
      try {
        createCredentialCrypto(rawInvalidKey);
        expect.fail("Deveria ter lançado CryptoError");
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoError);
        const errorMessage = (err as Error).message;
        expect(errorMessage).not.toContain(rawInvalidKey);
      }
    });
  });
});
