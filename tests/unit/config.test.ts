import { describe, expect, it } from "vitest";
import { bounded, readConfig } from "../../packages/config/src/index.js";
import {
  clientInput,
  clientUpdate,
} from "../../packages/contracts/src/index.js";
const valid = {
  APP_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://runtime:test@localhost/db",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "x".repeat(48),
};
describe("configuration fails closed", () => {
  it("accepts an explicit local environment", () => {
    expect(readConfig(valid).PORT).toBe(3001);
  });
  it.each([
    { SESSION_SECRET: "CHANGE_ME" },
    { DATABASE_URL: "https://example.test" },
    { PORT: "0" },
    { NODE_ENV: "production" },
    { REDIS_URL: "postgresql://localhost/db" },
  ])("rejects invalid configuration %j", (patch) => {
    expect(() => readConfig({ ...valid, ...patch })).toThrow();
  });
  it("permits production only with HTTPS and a secret", () => {
    expect(
      readConfig({
        ...valid,
        NODE_ENV: "production",
        APP_URL: "https://socialflow.example.test",
        DATABASE_URL: `postgresql://socialflow_runtime:${"d".repeat(32)}@localhost/db`,
        REDIS_URL: `redis://:${"r".repeat(32)}@localhost:6379`,
      }).NODE_ENV,
    ).toBe("production");
  });
  it.each([
    {
      DATABASE_URL: `postgresql://socialflow_migration:${"d".repeat(32)}@localhost/db`,
    },
    { REDIS_URL: "redis://localhost:6379" },
    { MIGRATION_DATABASE_URL: "postgresql://operator@localhost/db" },
    { ALLOW_DEV_SEED: "true" },
    { REDIS_URL: `redis://:${"d".repeat(32)}@localhost:6379` },
  ])("rejects unsafe production credentials %j", (patch) => {
    expect(() =>
      readConfig({
        ...valid,
        NODE_ENV: "production",
        APP_URL: "https://socialflow.example.test",
        DATABASE_URL: `postgresql://socialflow_runtime:${"d".repeat(32)}@localhost/db`,
        REDIS_URL: `redis://:${"r".repeat(32)}@localhost:6379`,
        ...patch,
      }),
    ).toThrow();
  });
  it("bounds a stalled dependency", async () => {
    await expect(bounded(new Promise(() => {}), 5)).rejects.toThrow("timeout");
  });

  describe("CREDENTIAL_MASTER_KEY validation and lack of fallback", () => {
    it("has no fallback when CREDENTIAL_MASTER_KEY is not provided", () => {
      const config = readConfig(valid);
      expect(config.CREDENTIAL_MASTER_KEY).toBeUndefined();
      expect(config.META_APP_ID).toBeUndefined();
      expect(config.META_APP_SECRET).toBeUndefined();
      expect(config.META_CONFIG_ID).toBeUndefined();
    });

    it("normalizes empty string to undefined without error", () => {
      const config = readConfig({
        ...valid,
        CREDENTIAL_MASTER_KEY: "",
        META_APP_ID: "",
        META_APP_SECRET: "",
        META_CONFIG_ID: "",
      });
      expect(config.CREDENTIAL_MASTER_KEY).toBeUndefined();
      expect(config.META_APP_ID).toBeUndefined();
      expect(config.META_APP_SECRET).toBeUndefined();
      expect(config.META_CONFIG_ID).toBeUndefined();
    });

    it("accepts a valid META_CONFIG_ID", () => {
      const config = readConfig({
        ...valid,
        META_CONFIG_ID: "1608043467489544",
      });
      expect(config.META_CONFIG_ID).toBe("1608043467489544");
    });

    it("accepts a valid 32-byte UTF-8 string or 64-character hex key", () => {
      const key32Bytes = "a".repeat(32);
      const key64Hex = "0123456789abcdef".repeat(4);
      expect(
        readConfig({ ...valid, CREDENTIAL_MASTER_KEY: key32Bytes })
          .CREDENTIAL_MASTER_KEY,
      ).toBe(key32Bytes);
      expect(
        readConfig({ ...valid, CREDENTIAL_MASTER_KEY: key64Hex })
          .CREDENTIAL_MASTER_KEY,
      ).toBe(key64Hex);
    });

    it.each([
      { CREDENTIAL_MASTER_KEY: "short" },
      { CREDENTIAL_MASTER_KEY: "a".repeat(31) },
      { CREDENTIAL_MASTER_KEY: "a".repeat(33) },
      { CREDENTIAL_MASTER_KEY: "0123456789abcdef".repeat(3) + "1234567" }, // 55 chars
      { CREDENTIAL_MASTER_KEY: "0123456789abcdef".repeat(4) + "0" }, // 65 chars
    ])("rejects invalid master key format %j", (patch) => {
      expect(() => readConfig({ ...valid, ...patch })).toThrow(
        /CREDENTIAL_MASTER_KEY deve ter exatamente 32 bytes/,
      );
    });
  });
});
describe("client contracts", () => {
  it("rejects mass assignment and tenant transfer", () => {
    expect(
      clientInput.safeParse({ name: "Cliente", slug: "cliente", role: "OWNER" })
        .success,
    ).toBe(false);
    expect(
      clientUpdate.safeParse({ name: "Cliente", organizationId: "org-b" })
        .success,
    ).toBe(false);
  });
  it("rejects invalid slugs and accepts normalized names", () => {
    expect(
      clientInput.safeParse({ name: "Cliente", slug: "../tenant" }).success,
    ).toBe(false);
    expect(
      clientInput.parse({ name: " Cliente ", slug: "cliente-a" }).name,
    ).toBe("Cliente");
  });
});
