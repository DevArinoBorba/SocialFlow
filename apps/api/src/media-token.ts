import { createHmac, timingSafeEqual } from "node:crypto";

export interface SignedMediaPayload {
  organizationId: string;
  clientId: string;
  mediaId: string;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  expiresAt: number;
}

export function createSignedMediaToken(
  secret: string,
  payload: SignedMediaPayload,
): string {
  const json = JSON.stringify(payload);
  const data = Buffer.from(json, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifySignedMediaToken(
  secret: string,
  token: string,
): SignedMediaPayload | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  if (!data || !sig) return null;

  const expectedSig = createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  const sigBuf = Buffer.from(sig, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");

  if (
    sigBuf.length !== expectedBuf.length ||
    !timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }

  try {
    const raw = Buffer.from(data, "base64url").toString("utf8");
    const payload = JSON.parse(raw) as SignedMediaPayload;
    if (
      typeof payload.expiresAt !== "number" ||
      Date.now() > payload.expiresAt
    ) {
      return null;
    }
    if (
      !payload.organizationId ||
      !payload.clientId ||
      !payload.mediaId ||
      !payload.storageKey ||
      !payload.mimeType ||
      !payload.sha256
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
