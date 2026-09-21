import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
const target = process.argv[2] ?? ".env";
if (![".env", ".local/test.env"].includes(target))
  throw new Error("Use .env ou .local/test.env");
if (existsSync(target)) throw new Error("Arquivo existente preservado");
mkdirSync(".local", { recursive: true });
const secret = () => randomBytes(24).toString("hex");
const test = target.includes("test");
writeFileSync(
  target,
  `APP_ENV=${test ? "test" : "development"}\nAPP_URL=http://localhost:3000\nWEB_PORT=3000\nSOCIALFLOW_IMAGE=${test ? "socialflow:test" : "socialflow:local"}\nPOSTGRES_PASSWORD=${secret()}\nRUNTIME_DB_PASSWORD=${secret()}\nREDIS_PASSWORD=${secret()}\nSESSION_SECRET=${secret()}\nDEV_SEED_PASSWORD=${secret()}\n`,
  { mode: 0o600 },
);
console.info(`Ambiente local gerado em ${target}; valores não exibidos.`);
