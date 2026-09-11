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
      }).NODE_ENV,
    ).toBe("production");
  });
  it("bounds a stalled dependency", async () => {
    await expect(bounded(new Promise(() => {}), 5)).rejects.toThrow("timeout");
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
