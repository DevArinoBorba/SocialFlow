import { z } from "zod";

const masterKeySchema = z.string().refine((val) => {
  if (/^[0-9a-fA-F]{64}$/.test(val)) return true;
  return new TextEncoder().encode(val).length === 32;
}, "CREDENTIAL_MASTER_KEY deve ter exatamente 32 bytes (ou 64 caracteres hexadecimais)");

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_URL: z.url(),
  DATABASE_URL: z
    .url()
    .refine((v) => v.startsWith("postgresql://"), "PostgreSQL obrigatório"),
  REDIS_URL: z.url().refine((v) => /^rediss?:/.test(v), "Redis obrigatório"),
  SESSION_SECRET: z
    .string()
    .min(32)
    .refine(
      (v) => !/CHANGE_ME|GENERATE_|placeholder/i.test(v),
      "Gere um segredo",
    ),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  META_APP_ID: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.string().optional(),
  ),
  META_APP_SECRET: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.string().optional(),
  ),
  META_GRAPH_URL: z.string().default("https://graph.facebook.com"),
  CREDENTIAL_MASTER_KEY: z.preprocess(
    (val) => (val === "" ? undefined : val),
    masterKeySchema.optional(),
  ),
});
export function readConfig(env: Record<string, string | undefined>) {
  const config = schema.parse(env);
  if (config.NODE_ENV === "production") {
    const database = new URL(config.DATABASE_URL);
    const redis = new URL(config.REDIS_URL);
    const passwords = [database.password, redis.password].map(
      decodeURIComponent,
    );
    if (
      database.username !== "socialflow_runtime" ||
      passwords.some(
        (p) => p.length < 24 || /CHANGE_ME|GENERATE_|placeholder/i.test(p),
      ) ||
      passwords[0] === passwords[1] ||
      passwords.includes(config.SESSION_SECRET) ||
      env.MIGRATION_DATABASE_URL ||
      env.POSTGRES_PASSWORD ||
      env.ALLOW_DEV_SEED === "true"
    )
      throw new Error(
        "Production requires independent secrets and runtime-only credentials",
      );
  }
  if (
    config.NODE_ENV === "production" &&
    !config.APP_URL.startsWith("https://")
  ) {
    throw new Error("APP_URL deve usar HTTPS em produção");
  }
  return config;
}
export type Config = ReturnType<typeof readConfig>;

export async function bounded<T>(work: Promise<T>, ms = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Dependency timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
