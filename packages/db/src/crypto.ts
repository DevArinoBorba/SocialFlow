import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class CryptoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CryptoError";
  }
}

export interface CredentialContext {
  organizationId: string;
  clientId: string;
  platformAccountId: string;
  keyVersion?: number;
}

export interface EncryptedCredentialPayload {
  encryptedAccessToken: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export interface CredentialCrypto {
  encrypt(
    plaintext: string,
    context: CredentialContext,
  ): EncryptedCredentialPayload;
  decrypt(
    payload: EncryptedCredentialPayload,
    context: CredentialContext,
  ): string;
}

export function buildAad(
  context: CredentialContext,
  keyVersion: number,
): Buffer {
  if (
    !context.organizationId ||
    !context.clientId ||
    !context.platformAccountId
  ) {
    throw new CryptoError("Incomplete context for AAD derivation");
  }
  const aadString = `${context.organizationId}:${context.clientId}:${context.platformAccountId}:${keyVersion}`;
  return Buffer.from(aadString, "utf8");
}

export function parseMasterKey(masterKey: string | Buffer): Buffer {
  let keyBuf: Buffer;
  if (Buffer.isBuffer(masterKey)) {
    keyBuf = masterKey;
  } else if (typeof masterKey === "string") {
    if (/^[0-9a-fA-F]{64}$/.test(masterKey)) {
      keyBuf = Buffer.from(masterKey, "hex");
    } else {
      keyBuf = Buffer.from(masterKey, "utf8");
    }
  } else {
    throw new CryptoError("Master key must be a string or Buffer");
  }

  if (keyBuf.length !== 32) {
    throw new CryptoError(
      `Master key must be exactly 32 bytes (256 bits). Received ${keyBuf.length} bytes.`,
    );
  }

  return keyBuf;
}

export function createCredentialCrypto(
  masterKey: string | Buffer,
  defaultKeyVersion = 1,
): CredentialCrypto {
  const resolvedKey = parseMasterKey(masterKey);

  return {
    encrypt(
      plaintext: string,
      context: CredentialContext,
    ): EncryptedCredentialPayload {
      if (typeof plaintext !== "string" || plaintext.length === 0) {
        throw new CryptoError("Plaintext must be a non-empty string");
      }

      const version = context.keyVersion ?? defaultKeyVersion;
      const aad = buildAad(context, version);
      const iv = randomBytes(12);

      try {
        const cipher = createCipheriv("aes-256-gcm", resolvedKey, iv);
        cipher.setAAD(aad);

        const encrypted = Buffer.concat([
          cipher.update(plaintext, "utf8"),
          cipher.final(),
        ]);
        const authTag = cipher.getAuthTag();

        return {
          encryptedAccessToken: encrypted.toString("base64"),
          iv: iv.toString("base64"),
          authTag: authTag.toString("base64"),
          keyVersion: version,
        };
      } catch (err) {
        throw new CryptoError(
          `Encryption failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },

    decrypt(
      payload: EncryptedCredentialPayload,
      context: CredentialContext,
    ): string {
      if (
        !payload ||
        !payload.encryptedAccessToken ||
        !payload.iv ||
        !payload.authTag
      ) {
        throw new CryptoError("Invalid payload structure");
      }

      if (
        context.keyVersion !== undefined &&
        payload.keyVersion !== undefined &&
        context.keyVersion !== payload.keyVersion
      ) {
        throw new CryptoError(
          `Key version mismatch: payload has ${payload.keyVersion}, context specified ${context.keyVersion}`,
        );
      }

      const version =
        payload.keyVersion ?? context.keyVersion ?? defaultKeyVersion;
      const aad = buildAad(context, version);

      let iv: Buffer;
      let authTag: Buffer;
      let ciphertext: Buffer;

      try {
        iv = Buffer.from(payload.iv, "base64");
        authTag = Buffer.from(payload.authTag, "base64");
        ciphertext = Buffer.from(payload.encryptedAccessToken, "base64");
      } catch (err) {
        throw new CryptoError("Malformed base64 in encrypted payload", {
          cause: err,
        });
      }

      if (iv.length !== 12) {
        throw new CryptoError(
          `Invalid IV length: expected 12 bytes, got ${iv.length}`,
        );
      }
      if (authTag.length !== 16) {
        throw new CryptoError(
          `Invalid authTag length: expected 16 bytes, got ${authTag.length}`,
        );
      }

      try {
        const decipher = createDecipheriv("aes-256-gcm", resolvedKey, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);

        const decrypted = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);

        return decrypted.toString("utf8");
      } catch (err) {
        throw new CryptoError(
          `Decryption failed (tampered data, incorrect key, or context mismatch): ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
  };
}

export interface KeyringConfig {
  keys: Record<number, string | Buffer>;
  activeVersion: number;
}

export interface KeyringCredentialCrypto extends CredentialCrypto {
  rotate(
    payload: EncryptedCredentialPayload,
    context: CredentialContext,
    targetVersion?: number,
  ): EncryptedCredentialPayload;
}

export function createKeyringCredentialCrypto(
  config: KeyringConfig,
): KeyringCredentialCrypto {
  const resolvedKeys = new Map<number, Buffer>();
  for (const [vStr, key] of Object.entries(config.keys)) {
    const version = Number(vStr);
    if (!Number.isInteger(version) || version < 1) {
      throw new CryptoError(`Invalid key version: ${vStr}`);
    }
    resolvedKeys.set(version, parseMasterKey(key));
  }

  if (!resolvedKeys.has(config.activeVersion)) {
    throw new CryptoError(
      `Active key version ${config.activeVersion} is not present in the keyring`,
    );
  }

  function getKey(version: number): Buffer {
    const key = resolvedKeys.get(version);
    if (!key) {
      throw new CryptoError(`Key version ${version} not found in keyring`);
    }
    return key;
  }

  return {
    encrypt(
      plaintext: string,
      context: CredentialContext,
    ): EncryptedCredentialPayload {
      const version = context.keyVersion ?? config.activeVersion;
      const key = getKey(version);
      const subCrypto = createCredentialCrypto(key, version);
      return subCrypto.encrypt(plaintext, { ...context, keyVersion: version });
    },

    decrypt(
      payload: EncryptedCredentialPayload,
      context: CredentialContext,
    ): string {
      const version =
        payload.keyVersion ?? context.keyVersion ?? config.activeVersion;
      const key = getKey(version);
      const subCrypto = createCredentialCrypto(key, version);
      return subCrypto.decrypt(payload, context);
    },

    rotate(
      payload: EncryptedCredentialPayload,
      context: CredentialContext,
      targetVersion?: number,
    ): EncryptedCredentialPayload {
      const target = targetVersion ?? config.activeVersion;
      const plaintext = this.decrypt(payload, context);
      return this.encrypt(plaintext, { ...context, keyVersion: target });
    },
  };
}
