import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  validateImage,
  mediaStorage,
  MAX_IMAGE_BYTES,
} from "../../apps/api/src/media-storage.js";
import { sanitizeClientCorrelationId } from "../../apps/api/src/media.js";
import sharp from "sharp";

describe("image validation", () => {
  it.each(["jpeg", "png", "webp"] as const)(
    "fully decodes and normalizes %s",
    async (format) => {
      const bytes = await sharp({
        create: { width: 12, height: 8, channels: 3, background: "#236046" },
      })
        .toFormat(format)
        .toBuffer();
      const result = await validateImage(bytes);
      expect(result.width).toBe(12);
      expect(result.height).toBe(8);
      expect(result.mimeType).toBe(`image/${format}`);
      expect(result.sha256).toHaveLength(64);
    },
  );

  it("strips EXIF and GPS metadata from uploaded images", async () => {
    const bytesWithExif = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#112233" },
    })
      .jpeg()
      .withMetadata({
        exif: {
          IFD0: {
            Make: "TestCamera",
            Model: "SecretModel",
            ImageDescription: "SecretLocation",
          },
        },
      })
      .toBuffer();

    const originalMeta = await sharp(bytesWithExif).metadata();
    expect(originalMeta.exif).toBeDefined();

    const result = await validateImage(bytesWithExif);
    const cleanedMeta = await sharp(result.data).metadata();
    expect(cleanedMeta.exif).toBeUndefined();
  });

  it("rejects animated WebP and multi-frame images", async () => {
    const staticWebp = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "blue" },
    })
      .webp()
      .toBuffer();

    const animatedWebpHeader = Buffer.concat([
      Buffer.from(
        "RIFF\x24\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x02\x00\x00\x00\x09\x00\x00\x09\x00\x00ANIM\x04\x00\x00\x00\x00\x00\x00\x00",
        "binary",
      ),
      staticWebp.subarray(12),
    ]);
    await expect(validateImage(animatedWebpHeader)).rejects.toThrow();

    const staticPng = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    const apng = Buffer.concat([
      staticPng.subarray(0, 33),
      Buffer.from("acTLfakeanimationchunkpayload"),
      staticPng.subarray(33),
    ]);
    await expect(validateImage(apng)).rejects.toThrow();
  });

  it("rejects false extensions, truncated image data and oversized bytes", async () => {
    await expect(validateImage(Buffer.from("not a png"))).rejects.toThrow();
    await expect(
      validateImage(Buffer.alloc(MAX_IMAGE_BYTES + 1)),
    ).rejects.toThrow();
    const bytes = await sharp({
      create: { width: 50, height: 50, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await expect(validateImage(bytes.subarray(0, 40))).rejects.toThrow();
  });

  it("rejects excessive pixel dimensions", async () => {
    const bytes = await sharp({
      create: { width: 6000, height: 5000, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await expect(validateImage(bytes)).rejects.toThrow();
  });
});

describe("media storage configuration", () => {
  it("returns null and disables media library when configuration is absent", () => {
    expect(mediaStorage({})).toBeNull();
  });

  it("returns null when configuration is incomplete", () => {
    expect(
      mediaStorage({
        MEDIA_S3_ENDPOINT: "http://127.0.0.1:9000",
        MEDIA_S3_BUCKET: "socialflow-media",
      }),
    ).toBeNull();
  });

  it("returns null when endpoint is an invalid URL", () => {
    expect(
      mediaStorage({
        MEDIA_S3_ENDPOINT: "not-a-url",
        MEDIA_S3_BUCKET: "socialflow-media",
        MEDIA_S3_ACCESS_KEY_ID: "key-id",
        MEDIA_S3_SECRET_ACCESS_KEY: "secret-key",
      }),
    ).toBeNull();
  });

  it("rejects reserved backup bucket and returns null", () => {
    expect(
      mediaStorage({
        MEDIA_S3_ENDPOINT: "http://127.0.0.1:9000",
        MEDIA_S3_BUCKET: "socialflow-backups",
        MEDIA_S3_ACCESS_KEY_ID: "key-id",
        MEDIA_S3_SECRET_ACCESS_KEY: "secret-key",
      }),
    ).toBeNull();

    expect(
      mediaStorage({
        MEDIA_S3_ENDPOINT: "http://127.0.0.1:9000",
        MEDIA_S3_BUCKET: "my-r2-backup-bucket",
        R2_BUCKET: "my-r2-backup-bucket",
        MEDIA_S3_ACCESS_KEY_ID: "key-id",
        MEDIA_S3_SECRET_ACCESS_KEY: "secret-key",
      }),
    ).toBeNull();
  });

  it("rejects reused backup credentials and returns null", () => {
    expect(
      mediaStorage({
        MEDIA_S3_ENDPOINT: "http://127.0.0.1:9000",
        MEDIA_S3_BUCKET: "socialflow-media",
        MEDIA_S3_ACCESS_KEY_ID: "backup-access-key",
        MEDIA_S3_SECRET_ACCESS_KEY: "different-key",
        R2_ACCESS_KEY_ID: "backup-access-key",
      }),
    ).toBeNull();

    expect(
      mediaStorage({
        MEDIA_S3_ENDPOINT: "http://127.0.0.1:9000",
        MEDIA_S3_BUCKET: "socialflow-media",
        MEDIA_S3_ACCESS_KEY_ID: "unique-key",
        MEDIA_S3_SECRET_ACCESS_KEY: "backup-secret",
        R2_SECRET_ACCESS_KEY: "backup-secret",
      }),
    ).toBeNull();
  });

  it("rejects HTTP in production environment", () => {
    expect(
      mediaStorage({
        NODE_ENV: "production",
        MEDIA_S3_ENDPOINT: "http://s3.example.com",
        MEDIA_S3_BUCKET: "socialflow-media",
        MEDIA_S3_ACCESS_KEY_ID: "key-id",
        MEDIA_S3_SECRET_ACCESS_KEY: "secret-key",
      }),
    ).toBeNull();
  });

  it("initializes client with isolated and valid configuration", () => {
    const client = mediaStorage({
      MEDIA_S3_ENDPOINT: "http://127.0.0.1:9000",
      MEDIA_S3_BUCKET: "socialflow-media",
      MEDIA_S3_ACCESS_KEY_ID: "media-key",
      MEDIA_S3_SECRET_ACCESS_KEY: "media-secret",
    });
    expect(client).not.toBeNull();
    expect(typeof client?.put).toBe("function");
    expect(typeof client?.get).toBe("function");
    expect(typeof client?.close).toBe("function");
    client?.close();
  });

  it("normalizes trailing slash in endpoint and accepts MEDIA_S3_REGION", () => {
    const client = mediaStorage({
      MEDIA_S3_ENDPOINT: "http://127.0.0.1:9000///",
      MEDIA_S3_REGION: "us-east-1",
      MEDIA_S3_BUCKET: "socialflow-media",
      MEDIA_S3_ACCESS_KEY_ID: "media-key",
      MEDIA_S3_SECRET_ACCESS_KEY: "media-secret",
    });
    expect(client).not.toBeNull();
    client?.close();
  });
});

describe("correlation ID sanitization and generation", () => {
  it("accepts valid alphanumeric, dash and underscore client correlation IDs up to 64 characters", () => {
    expect(sanitizeClientCorrelationId("trace-12345_ABC")).toBe(
      "trace-12345_ABC",
    );
    expect(sanitizeClientCorrelationId("a".repeat(64))).toBe("a".repeat(64));
    expect(sanitizeClientCorrelationId("  clean-spaces  ")).toBe(
      "clean-spaces",
    );
  });

  it("rejects invalid, malicious or excessive client correlation IDs", () => {
    expect(sanitizeClientCorrelationId("")).toBeNull();
    expect(sanitizeClientCorrelationId("   ")).toBeNull();
    expect(sanitizeClientCorrelationId("a".repeat(65))).toBeNull();
    expect(sanitizeClientCorrelationId("a".repeat(500))).toBeNull();
    expect(sanitizeClientCorrelationId("id with spaces")).toBeNull();
    expect(sanitizeClientCorrelationId("id\nwith\nnewlines")).toBeNull();
    expect(
      sanitizeClientCorrelationId("id<script>alert(1)</script>"),
    ).toBeNull();
    expect(sanitizeClientCorrelationId("id;DROP TABLE;")).toBeNull();
    expect(sanitizeClientCorrelationId(null)).toBeNull();
    expect(sanitizeClientCorrelationId(undefined)).toBeNull();
    expect(sanitizeClientCorrelationId(12345)).toBeNull();
    expect(sanitizeClientCorrelationId({})).toBeNull();
  });

  it("generates a valid random UUID (UUID v4) for internal correlation", () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    expect(id1).not.toBe(id2);
    // UUID v4 format: 8-4-4-4-12 hex digits with 4 at version position
    expect(id1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(id2).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
