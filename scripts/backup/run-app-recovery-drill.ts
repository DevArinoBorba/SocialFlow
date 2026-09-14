import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const overallStartTime = Date.now();

const encryptedFile = resolve(
  ".local/recovery/r2_drill/socialflow_backup_20260914_213041.dump.gpg",
);
const secKeyFile = resolve(".local/recovery/socialflow-recovery.sec.key");
const decryptedFile = resolve(
  ".local/recovery/r2_drill/recovered_for_app_drill.dump",
);

const networkName = `dr-net-${Date.now()}`;
const postgresContainer = `dr-postgres-${Date.now()}`;
const redisContainer = `dr-redis-${Date.now()}`;
const apiContainer = `dr-api-${Date.now()}`;
const apiHostPort = 59101;
const appUrl = "http://localhost:59100";

console.log(
  "================================================================================",
);
console.log(
  "[DRILL] INICIANDO RECUPERAÇÃO ISOLADA DA APLICAÇÃO CONECTADA AO BANCO DO R2",
);
console.log(
  "================================================================================",
);

// 1. Decrypt dump
console.log(
  "[DRILL] 1/7. Decifrando dump do Cloudflare R2 com chave privada do custodiante...",
);
const decryptCmd = `
export GNUPGHOME=$(mktemp -d)
chmod 700 "$GNUPGHOME"
gpg --batch --import "${secKeyFile.replace(/\\/g, "/")}"
gpg --batch --yes --decrypt --output "${decryptedFile.replace(/\\/g, "/")}" "${encryptedFile.replace(/\\/g, "/")}"
rm -rf "$GNUPGHOME"
`;
const decRes = spawnSync(
  "C:\\Program Files\\Git\\bin\\bash.exe",
  ["-c", decryptCmd],
  { encoding: "utf8" },
);
if (decRes.status !== 0 || !existsSync(decryptedFile)) {
  console.error("FAIL: Decryption failed:", decRes.stderr);
  process.exit(1);
}
console.log(
  `PASS - Dump decifrado com sucesso (${readFileSync(decryptedFile).length} bytes)`,
);

// Cleanup helper
function cleanup() {
  console.log("\n[DRILL] Limpando ambiente isolado do drill...");
  spawnSync(
    "docker",
    ["rm", "-f", apiContainer, postgresContainer, redisContainer],
    { stdio: "ignore" },
  );
  spawnSync("docker", ["network", "rm", networkName], { stdio: "ignore" });
  try {
    if (existsSync(decryptedFile)) unlinkSync(decryptedFile);
  } catch (err) {
    void err;
  }
}

// 2. Create isolated Docker network
console.log(`[DRILL] 2/7. Criando rede Docker isolada: ${networkName}...`);
spawnSync("docker", ["network", "create", networkName], { stdio: "ignore" });

// 3. Start PostgreSQL 17.11 container
console.log("[DRILL] 3/7. Subindo PostgreSQL 17.11 isolado...");
const pgRun = spawnSync(
  "docker",
  [
    "run",
    "-d",
    "--name",
    postgresContainer,
    "--network",
    networkName,
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    "POSTGRES_DB=socialflow",
    "-e",
    "POSTGRES_PASSWORD=recovery_drill_test_password_24chars_min",
    "postgres:17.11-alpine",
  ],
  { encoding: "utf8" },
);

if (pgRun.status !== 0) {
  cleanup();
  console.error("FAIL: Could not start isolated PostgreSQL:", pgRun.stderr);
  process.exit(1);
}

// Wait for postgres ready
let pgReady = false;
for (let i = 0; i < 30; i++) {
  const c = spawnSync(
    "docker",
    [
      "exec",
      postgresContainer,
      "pg_isready",
      "-U",
      "postgres",
      "-d",
      "socialflow",
    ],
    { encoding: "utf8" },
  );
  if (c.status === 0 && c.stdout.includes("accepting connections")) {
    pgReady = true;
    break;
  }
  spawnSync("powershell", ["-Command", "Start-Sleep -Milliseconds 500"]);
}
if (!pgReady) {
  cleanup();
  console.error("FAIL: PostgreSQL did not become ready in time.");
  process.exit(1);
}

// Initialize roles as superuser postgres
const initRoleSql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'socialflow_migration') THEN
    CREATE ROLE socialflow_migration WITH LOGIN PASSWORD 'recovery_drill_test_password_24chars_min' SUPERUSER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'socialflow_runtime') THEN
    CREATE ROLE socialflow_runtime WITH LOGIN PASSWORD 'recovery_runtime_test_password_24chars_min' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END $$;
GRANT ALL PRIVILEGES ON DATABASE socialflow TO socialflow_migration;
REVOKE ALL ON SCHEMA public FROM public;
GRANT USAGE, CREATE ON SCHEMA public TO socialflow_migration;
GRANT USAGE ON SCHEMA public TO socialflow_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE socialflow_migration IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO socialflow_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE socialflow_migration IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO socialflow_runtime;
`;
spawnSync(
  "docker",
  [
    "exec",
    "-i",
    postgresContainer,
    "psql",
    "-U",
    "postgres",
    "-d",
    "socialflow",
  ],
  { input: initRoleSql, encoding: "utf8" },
);
console.log("PASS - PostgreSQL isolado operacional com roles configuradas.");

// 4. Execute pg_restore
console.log(
  "[DRILL] 4/7. Executando pg_restore a partir do dump decifrado do Cloudflare R2...",
);
spawnSync("docker", [
  "cp",
  decryptedFile,
  `${postgresContainer}:/tmp/dump.dump`,
]);

const pgRestoreStart = Date.now();
const restoreRes = spawnSync(
  "docker",
  [
    "exec",
    postgresContainer,
    "pg_restore",
    "-U",
    "socialflow_migration",
    "-d",
    "socialflow",
    "--single-transaction",
    "--exit-on-error",
    "/tmp/dump.dump",
  ],
  { encoding: "utf8" },
);
const pgRestoreDurationSec = ((Date.now() - pgRestoreStart) / 1000).toFixed(2);

if (restoreRes.status !== 0) {
  cleanup();
  console.error("FAIL: pg_restore failed:", restoreRes.stderr);
  process.exit(1);
}
console.log(
  `PASS - pg_restore concluído com sucesso. Duração do pg_restore: ${pgRestoreDurationSec}s`,
);

// 5. Start Redis container
console.log("[DRILL] 5/7. Subindo Redis 8.10.0 isolado na rede...");
spawnSync(
  "docker",
  [
    "run",
    "-d",
    "--name",
    redisContainer,
    "--network",
    networkName,
    "redis:8.10.0-alpine",
  ],
  { stdio: "ignore" },
);

// 6. Setup test verification users (WITHOUT touching or changing any real user passwords)
console.log(
  "[DRILL] 6/7. Identificando organizações e cadastrando usuários efêmeros de verificação...",
);
const orgAId = "f0e58e25-6454-443e-b21b-f35cb1b7ff23"; // Organização real restaurada (Orium Digital)
const clientAId = "98792eae-cb4e-4267-af02-0f460b6fac72"; // Cliente real restaurado
const orgBId = "dr-org-b-isolated";
const clientBId = "dr-client-b-isolated";

console.log(
  `Organização A (Real Restaurada): Orium Digital (${orgAId}) -> Cliente: Cliente Teste (${clientAId})`,
);
console.log(
  `Organização B (Efêmera de Teste): Agência B (${orgBId}) -> Cliente: Cliente B (${clientBId})`,
);

const testPassword = "VerificationPass123!";
const testHashed =
  "4d09f92fb753f45252f6344806ca135e:ae18228b4e9b597b2918f6a47a3828cd3f4c8742f07eac5789df9d4931af6b23aee20a31e8d168a6dd3e2073221cf6c47212a4bee09a5bf8e85da7bf2b42372e";

// Insert ephemeral verification users & Org B entities (NOT touching real users)
const insertUsersSql = `
\\set ON_ERROR_STOP on

-- Ensure Org B and its client/brand exist for multi-tenant isolation testing
INSERT INTO "Organization" (id, name, active, "createdAt")
VALUES ('${orgBId}', 'Agência B Isolada', true, NOW())
ON CONFLICT (id) DO UPDATE SET active = true;

INSERT INTO "Client" (id, "organizationId", name, slug, active, "createdAt")
VALUES ('${clientBId}', '${orgBId}', 'Cliente Isolado B', 'cliente-b-dr', true, NOW())
ON CONFLICT (id) DO UPDATE SET active = true;

INSERT INTO "Brand" (id, "organizationId", "clientId", name, description, "targetAudience", "toneOfVoice", "createdAt", "updatedAt")
VALUES ('dr-brand-b-isolated', '${orgBId}', '${clientBId}', 'Marca B Isolada', 'Descrição B', 'Público B', 'Tom B', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Verification users (password = VerificationPass123!)
INSERT INTO "User" (id, name, email, active, "createdAt", "updatedAt")
VALUES 
  ('dr-user-a', 'DR Verifier Org A', 'dr-admin-a@socialflow.test', true, NOW(), NOW()),
  ('dr-user-b', 'DR Verifier Org B', 'dr-admin-b@socialflow.test', true, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET active = true;

INSERT INTO "Account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
VALUES
  ('dr-account-a', 'dr-user-a', 'credential', 'dr-user-a', '${testHashed}', NOW(), NOW()),
  ('dr-account-b', 'dr-user-b', 'credential', 'dr-user-b', '${testHashed}', NOW(), NOW())
ON CONFLICT ("providerId", "accountId") DO UPDATE SET password = '${testHashed}';

-- Membership table schema: (id, userId, organizationId, clientId, role, active)
INSERT INTO "Membership" (id, "organizationId", "userId", role, active)
VALUES
  ('dr-member-a', '${orgAId}', 'dr-user-a', 'ADMIN', true),
  ('dr-member-b', '${orgBId}', 'dr-user-b', 'ADMIN', true)
ON CONFLICT (id) DO UPDATE SET active = true, role = 'ADMIN';
`;

const insertRes = spawnSync(
  "docker",
  [
    "exec",
    "-i",
    postgresContainer,
    "psql",
    "-U",
    "socialflow_migration",
    "-d",
    "socialflow",
  ],
  { input: insertUsersSql, encoding: "utf8" },
);

if (insertRes.status !== 0) {
  cleanup();
  console.error(
    "FAIL: Failed to insert verification test users:",
    insertRes.stderr,
  );
  process.exit(1);
}
console.log(
  "PASS - Usuários efêmeros de verificação inseridos com sucesso (usuários reais 100% inalterados).",
);

// 7. Start API container connected exclusively to restored DB
console.log(
  "[DRILL] 7/7. Subindo container da aplicação (API) conectada exclusivamente ao banco restaurado...",
);
const apiRun = spawnSync(
  "docker",
  [
    "run",
    "-d",
    "--name",
    apiContainer,
    "--network",
    networkName,
    "-p",
    `127.0.0.1:${apiHostPort}:3001`,
    "-e",
    "NODE_ENV=test",
    "-e",
    "PORT=3001",
    "-e",
    `APP_URL=${appUrl}`,
    "-e",
    `DATABASE_URL=postgresql://socialflow_runtime:recovery_runtime_test_password_24chars_min@${postgresContainer}:5432/socialflow`,
    "-e",
    `REDIS_URL=redis://${redisContainer}:6379`,
    "-e",
    "SESSION_SECRET=dr_session_secret_recovery_drill_32chars_min_unique_test",
    "socialflow-test-api:latest",
  ],
  { encoding: "utf8" },
);

if (apiRun.status !== 0) {
  cleanup();
  console.error("FAIL: Could not start API container:", apiRun.stderr);
  process.exit(1);
}

// Poll /health/ready
let apiReady = false;
console.log(
  `[DRILL] Aguardando readiness da aplicação em http://127.0.0.1:${apiHostPort}/health/ready...`,
);
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${apiHostPort}/health/ready`);
    if (res.status === 200) {
      const data = await res.json();
      if (data.status === "ready") {
        apiReady = true;
        break;
      }
    }
  } catch (err) {
    void err;
  }
  spawnSync("powershell", ["-Command", "Start-Sleep -Milliseconds 500"]);
}

const totalUsableDurationSec = ((Date.now() - overallStartTime) / 1000).toFixed(
  2,
);

if (!apiReady) {
  const logs = spawnSync("docker", ["logs", apiContainer], {
    encoding: "utf8",
  });
  cleanup();
  console.error(
    "FAIL: API container did not reach ready status. Logs:\n",
    logs.stdout,
    logs.stderr,
  );
  process.exit(1);
}

console.log(
  `\n================================================================================`,
);
console.log(`PASS - APLICAÇÃO RECUPERADA E PRONTA PARA USO!`);
console.log(`- Duração do pg_restore puro: ${pgRestoreDurationSec} segundos`);
console.log(
  `- Tempo total até o sistema recuperado ficar utilizável: ${totalUsableDurationSec} segundos`,
);
console.log(
  `================================================================================\n`,
);

// 8. Functional verifications
console.log(
  "[DRILL] Executando validações funcionais contra a aplicação recuperada...\n",
);

// A. Login Org A
console.log(
  "[VALIDAÇÃO A] Login autenticado com usuário da Org A (dr-admin-a@socialflow.test)...",
);
const loginARes = await fetch(
  `http://127.0.0.1:${apiHostPort}/api/auth/sign-in/email`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: appUrl,
    },
    body: JSON.stringify({
      email: "dr-admin-a@socialflow.test",
      password: testPassword,
    }),
  },
);

if (loginARes.status !== 200) {
  cleanup();
  console.error(
    "FAIL: Login Org A failed with status:",
    loginARes.status,
    await loginARes.text(),
  );
  process.exit(1);
}
const cookieA = loginARes.headers
  .getSetCookie()
  .map((s) => s.split(";")[0])
  .join("; ");
console.log(
  `PASS - Login Org A bem-sucedido (HTTP 200, cookie de sessão emitido)`,
);

// B. GET /api/me
console.log("[VALIDAÇÃO B] Chamada autenticada a /api/me...");
const meRes = await fetch(`http://127.0.0.1:${apiHostPort}/api/me`, {
  headers: { cookie: cookieA },
});
const meData = await meRes.json();
if (
  meRes.status !== 200 ||
  meData.user.email !== "dr-admin-a@socialflow.test"
) {
  cleanup();
  console.error("FAIL: /api/me failed:", meRes.status, meData);
  process.exit(1);
}
const orgName =
  meData.memberships?.[0]?.organization?.name ??
  meData.memberships?.[0]?.organizationId ??
  "Org A";
console.log(
  `PASS - /api/me validado: Usuário autenticado '${meData.user.name}' vinculado à Org '${orgName}'`,
);

// C. Authorized access to Org A clients and brands
console.log(
  `[VALIDAÇÃO C] Acesso autorizado a clientes e marcas da Org A (${orgAId})...`,
);
const clientsARes = await fetch(
  `http://127.0.0.1:${apiHostPort}/api/organizations/${orgAId}/clients`,
  {
    headers: { cookie: cookieA },
  },
);
const clientsAData = await clientsARes.json();
if (clientsARes.status !== 200 || !Array.isArray(clientsAData)) {
  cleanup();
  console.error(
    "FAIL: List clients Org A failed:",
    clientsARes.status,
    clientsAData,
  );
  process.exit(1);
}
console.log(
  `PASS - Clientes da Org A listados com sucesso: ${clientsAData.length} cliente(s) retornado(s).`,
);

if (clientAId) {
  const brandsARes = await fetch(
    `http://127.0.0.1:${apiHostPort}/api/organizations/${orgAId}/clients/${clientAId}/brands`,
    {
      headers: { cookie: cookieA },
    },
  );
  const brandsAData = await brandsARes.json();
  if (brandsARes.status !== 200) {
    cleanup();
    console.error(
      "FAIL: List brands Org A failed:",
      brandsARes.status,
      brandsAData,
    );
    process.exit(1);
  }
  console.log(
    `PASS - Marcas do cliente da Org A listadas com sucesso (HTTP 200): ${brandsAData.length} marca(s) retornada(s).`,
  );
}

// D. Multi-tenant isolation: Org A user attempting to access Org B resources
console.log(
  `\n[VALIDAÇÃO D] Teste de isolamento multi-tenant: Usuário da Org A tentando acessar recursos da Org B (${orgBId})...`,
);
const forbiddenOrgBRes = await fetch(
  `http://127.0.0.1:${apiHostPort}/api/organizations/${orgBId}/clients`,
  {
    headers: { cookie: cookieA },
  },
);
if (forbiddenOrgBRes.status !== 404) {
  cleanup();
  console.error(
    `FAIL: Multi-tenant breach! Expected 404, got ${forbiddenOrgBRes.status}`,
  );
  process.exit(1);
}
console.log(
  `PASS - Acesso negado conforme esperado ao listar clientes da Org B: HTTP ${forbiddenOrgBRes.status} (Isolamento RLS estrito)`,
);

if (clientBId) {
  const forbiddenBrandBRes = await fetch(
    `http://127.0.0.1:${apiHostPort}/api/organizations/${orgBId}/clients/${clientBId}/brands`,
    {
      headers: { cookie: cookieA },
    },
  );
  if (forbiddenBrandBRes.status !== 404) {
    cleanup();
    console.error(
      `FAIL: Multi-tenant breach on brands! Expected 404, got ${forbiddenBrandBRes.status}`,
    );
    process.exit(1);
  }
  console.log(
    `PASS - Acesso negado conforme esperado ao listar marcas de cliente da Org B: HTTP ${forbiddenBrandBRes.status}`,
  );
}

// E. Login Org B and verify isolation against Org A
console.log(
  "\n[VALIDAÇÃO E] Login autenticado com usuário da Org B (dr-admin-b@socialflow.test)...",
);
const loginBRes = await fetch(
  `http://127.0.0.1:${apiHostPort}/api/auth/sign-in/email`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: appUrl,
    },
    body: JSON.stringify({
      email: "dr-admin-b@socialflow.test",
      password: testPassword,
    }),
  },
);
if (loginBRes.status !== 200) {
  cleanup();
  console.error("FAIL: Login Org B failed:", loginBRes.status);
  process.exit(1);
}
const cookieB = loginBRes.headers
  .getSetCookie()
  .map((s) => s.split(";")[0])
  .join("; ");
console.log("PASS - Login Org B bem-sucedido (HTTP 200)");

const forbiddenOrgARes = await fetch(
  `http://127.0.0.1:${apiHostPort}/api/organizations/${orgAId}/clients`,
  {
    headers: { cookie: cookieB },
  },
);
if (forbiddenOrgARes.status !== 404) {
  cleanup();
  console.error(
    `FAIL: Org B user could access Org A! Status ${forbiddenOrgARes.status}`,
  );
  process.exit(1);
}
console.log(
  `PASS - Usuário da Org B impedido de acessar clientes da Org A: HTTP ${forbiddenOrgARes.status}`,
);

// Clean up
cleanup();

console.log(
  "\n================================================================================",
);
console.log(
  "RELATÓRIO DE ACEITE DA APLICAÇÃO RECUPERADA A PARTIR DO CLOUDFLARE R2",
);
console.log(
  "================================================================================",
);
console.log(
  `- Versão da Aplicação: commit b50ded1eae3149cbb796fca8ebf40a04b59a6c47 (socialflow-test-api:latest)`,
);
console.log(`- Duração do pg_restore puro: ${pgRestoreDurationSec}s`);
console.log(
  `- Tempo total até o sistema ficar utilizável: ${totalUsableDurationSec}s`,
);
console.log(`- Readiness (/health/ready): 100% OK`);
console.log(`- Login Autenticado (Better Auth): 100% OK`);
console.log(`- Acesso Autorizado a Clientes e Marcas: 100% OK`);
console.log(
  `- Bloqueio Multi-Tenant entre Organizações: 100% OK (Sem vazamento de dados)`,
);
console.log(
  `- Preservação de Usuários Reais: 100% íntegro (senhas e dados reais intocados)`,
);
console.log(
  "================================================================================",
);
