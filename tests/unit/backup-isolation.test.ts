import { describe, it, expect } from "vitest";

function resolveBackupEnvironment(rawEnv?: string): "prod" | "homolog" {
  if (!rawEnv || !rawEnv.trim()) {
    throw new Error(
      "Target environment must be explicitly specified (set SOCIALFLOW_ENV=prod or SOCIALFLOW_ENV=homolog). Silent fallback is prohibited.",
    );
  }
  const normalized = rawEnv.trim().toLowerCase();
  if (normalized === "prod" || normalized === "production") {
    return "prod";
  }
  if (
    normalized === "homolog" ||
    normalized === "homologation" ||
    normalized === "staging"
  ) {
    return "homolog";
  }
  throw new Error(
    `Invalid target environment '${rawEnv}'. Allowed values are 'prod' or 'homolog'.`,
  );
}

function resolveBackupPrefix(
  env: "prod" | "homolog",
  customPrefix?: string,
): string {
  const prefix = customPrefix || `backups/socialflow/${env}`;
  if (env === "prod" && prefix.includes("homolog")) {
    throw new Error(
      `Cross-environment violation: refusing to run production backup with homologation prefix '${prefix}'.`,
    );
  }
  if (env === "homolog" && prefix.includes("prod")) {
    throw new Error(
      `Cross-environment violation: refusing to run homologation backup with production prefix '${prefix}'.`,
    );
  }
  return prefix;
}

function validatePostgresContainer(
  env: "prod" | "homolog",
  containerName: string,
): void {
  if (!containerName || !containerName.trim()) {
    throw new Error(
      `Could not detect running PostgreSQL container for environment '${env}'.`,
    );
  }
  if (
    env === "prod" &&
    /(4iuijgj7ocivevuow4yga8z7|homolog)/i.test(containerName)
  ) {
    throw new Error(
      `Safety violation: PostgreSQL container '${containerName}' belongs to homologation, but TARGET_ENV is 'prod'!`,
    );
  }
  if (
    env === "homolog" &&
    /(drio4inydistgaevc6az7kks|production)/i.test(containerName)
  ) {
    throw new Error(
      `Safety violation: PostgreSQL container '${containerName}' belongs to production, but TARGET_ENV is 'homolog'!`,
    );
  }
}

describe("Backup environment isolation rules", () => {
  it("resolves production environments correctly", () => {
    expect(resolveBackupEnvironment("prod")).toBe("prod");
    expect(resolveBackupEnvironment("PROD")).toBe("prod");
    expect(resolveBackupEnvironment("production")).toBe("prod");
    expect(resolveBackupEnvironment("PRODUCTION")).toBe("prod");
  });

  it("resolves homologation environments correctly", () => {
    expect(resolveBackupEnvironment("homolog")).toBe("homolog");
    expect(resolveBackupEnvironment("HOMOLOG")).toBe("homolog");
    expect(resolveBackupEnvironment("homologation")).toBe("homolog");
    expect(resolveBackupEnvironment("staging")).toBe("homolog");
  });

  it("fails when environment is missing or empty (no silent fallback)", () => {
    expect(() => resolveBackupEnvironment()).toThrow(
      /must be explicitly specified/,
    );
    expect(() => resolveBackupEnvironment("")).toThrow(
      /must be explicitly specified/,
    );
    expect(() => resolveBackupEnvironment("  ")).toThrow(
      /must be explicitly specified/,
    );
  });

  it("fails when environment is invalid", () => {
    expect(() => resolveBackupEnvironment("dev")).toThrow(
      /Invalid target environment/,
    );
    expect(() => resolveBackupEnvironment("testing")).toThrow(
      /Invalid target environment/,
    );
  });

  it("assigns isolated R2 prefixes per environment", () => {
    expect(resolveBackupPrefix("prod")).toBe("backups/socialflow/prod");
    expect(resolveBackupPrefix("homolog")).toBe("backups/socialflow/homolog");
  });

  it("blocks cross-environment R2 prefix overwrite attempts", () => {
    expect(() =>
      resolveBackupPrefix("prod", "backups/socialflow/homolog"),
    ).toThrow(/Cross-environment violation/);

    expect(() =>
      resolveBackupPrefix("homolog", "backups/socialflow/prod"),
    ).toThrow(/Cross-environment violation/);
  });

  it("allows safe custom prefixes that do not cross environments", () => {
    expect(resolveBackupPrefix("prod", "backups/socialflow/prod/nightly")).toBe(
      "backups/socialflow/prod/nightly",
    );
    expect(
      resolveBackupPrefix("homolog", "backups/socialflow/homolog/manual"),
    ).toBe("backups/socialflow/homolog/manual");
  });

  it("validates that production cannot target homologation PostgreSQL containers", () => {
    expect(() =>
      validatePostgresContainer(
        "prod",
        "postgres-4iuijgj7ocivevuow4yga8z7-143658350138",
      ),
    ).toThrow(/belongs to homologation/);

    expect(() =>
      validatePostgresContainer("prod", "socialflow-homolog-postgres"),
    ).toThrow(/belongs to homologation/);
  });

  it("validates that homologation cannot target production PostgreSQL containers", () => {
    expect(() =>
      validatePostgresContainer(
        "homolog",
        "postgres-drio4inydistgaevc6az7kks-193003637482",
      ),
    ).toThrow(/belongs to production/);

    expect(() =>
      validatePostgresContainer("homolog", "socialflow-production-postgres"),
    ).toThrow(/belongs to production/);
  });

  it("accepts valid container names for their respective environments", () => {
    expect(() =>
      validatePostgresContainer(
        "prod",
        "postgres-drio4inydistgaevc6az7kks-193003637482",
      ),
    ).not.toThrow();

    expect(() =>
      validatePostgresContainer(
        "homolog",
        "postgres-4iuijgj7ocivevuow4yga8z7-143658350138",
      ),
    ).not.toThrow();
  });
});
