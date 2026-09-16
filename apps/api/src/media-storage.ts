import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import { createHash } from "node:crypto";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export async function validateImage(input: Buffer) {
  if (!input.length || input.length > MAX_IMAGE_BYTES)
    throw new Error("Invalid image size");
  const options = { limitInputPixels: 25_000_000, failOn: "warning" as const };
  const meta = await sharp(input, options).metadata();
  const isAnimatedWebp =
    meta.format === "webp" &&
    ((input.length >= 21 &&
      input.subarray(12, 16).toString("ascii") === "VP8X" &&
      Boolean((input[20] ?? 0) & 0x02)) ||
      input.includes(Buffer.from("ANIM")));
  const isAnimatedPng =
    meta.format === "png" && input.includes(Buffer.from("acTL"));
  if (
    !meta.format ||
    !["jpeg", "png", "webp"].includes(meta.format) ||
    (meta.pages ?? 1) > 1 ||
    isAnimatedWebp ||
    isAnimatedPng
  )
    throw new Error("Unsupported image");
  // Full decode/re-encode rejects truncated pixels and strips metadata/trailing payloads.
  const { data, info } = await sharp(input, options)
    .rotate()
    .toBuffer({ resolveWithObject: true });
  if (data.length > MAX_IMAGE_BYTES) throw new Error("Image output too large");
  return {
    data,
    mimeType: `image/${info.format}`,
    byteSize: data.length,
    width: info.width,
    height: info.height,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

export function mediaStorage(env: NodeJS.ProcessEnv) {
  const {
    MEDIA_S3_ENDPOINT: endpoint,
    MEDIA_S3_BUCKET: bucket,
    MEDIA_S3_ACCESS_KEY_ID: accessKeyId,
    MEDIA_S3_SECRET_ACCESS_KEY: secretAccessKey,
  } = env;
  if (![endpoint, bucket, accessKeyId, secretAccessKey].some(Boolean)) {
    console.info(
      JSON.stringify({
        event: "media_storage_unconfigured",
        message:
          "Armazenamento de mídia não configurado; biblioteca desabilitada.",
      }),
    );
    return null;
  }
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    console.warn(
      JSON.stringify({
        event: "media_storage_disabled",
        reason: "missing_required_fields",
      }),
    );
    return null;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint);
  } catch {
    console.warn(
      JSON.stringify({
        event: "media_storage_disabled",
        reason: "invalid_endpoint_url",
      }),
    );
    return null;
  }
  if (env.NODE_ENV === "production" && parsedUrl.protocol !== "https:") {
    console.warn(
      JSON.stringify({
        event: "media_storage_disabled",
        reason: "insecure_http_in_production",
      }),
    );
    return null;
  }
  if (
    bucket === "socialflow-backups" ||
    (Boolean(env.R2_BUCKET) && bucket === env.R2_BUCKET)
  ) {
    console.warn(
      JSON.stringify({
        event: "media_storage_disabled",
        reason: "reserved_backup_bucket",
      }),
    );
    return null;
  }
  if (
    (Boolean(env.R2_ACCESS_KEY_ID) && accessKeyId === env.R2_ACCESS_KEY_ID) ||
    (Boolean(env.R2_SECRET_ACCESS_KEY) &&
      secretAccessKey === env.R2_SECRET_ACCESS_KEY)
  ) {
    console.warn(
      JSON.stringify({
        event: "media_storage_disabled",
        reason: "shared_backup_credentials",
      }),
    );
    return null;
  }
  try {
    const client = new S3Client({
      endpoint: endpoint.replace(/\/+$/, ""),
      region: env.MEDIA_S3_REGION || "auto",
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      maxAttempts: 2,
    });
    console.info(JSON.stringify({ event: "media_storage_initialized" }));
    return {
      async put(key: string, data: Buffer, mimeType: string) {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: data,
            ContentType: mimeType,
            IfNoneMatch: "*",
          }),
          { abortSignal: AbortSignal.timeout(15000) },
        );
      },
      async get(key: string) {
        const result = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          { abortSignal: AbortSignal.timeout(15000) },
        );
        if (
          !result.Body ||
          (result.ContentLength ?? Infinity) > MAX_IMAGE_BYTES
        )
          throw new Error("Invalid stored image");
        const parts: Buffer[] = [];
        let bytes = 0;
        for await (const part of result.Body as AsyncIterable<Uint8Array>) {
          bytes += part.length;
          if (bytes > MAX_IMAGE_BYTES) throw new Error("Invalid stored image");
          parts.push(Buffer.from(part));
        }
        return Buffer.concat(parts);
      },
      close() {
        client.destroy();
      },
    };
  } catch {
    console.warn(
      JSON.stringify({
        event: "media_storage_disabled",
        reason: "client_initialization_failed",
      }),
    );
    return null;
  }
}
