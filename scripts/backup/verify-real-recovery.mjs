// Operational drill: direct R2 GETs, exact deployed API image, isolated storage.
// Never prints signed URLs, key material, passwords, cookies or restored rows.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";

const docker =
  process.env.DOCKER_BIN ||
  "C:/Users/arino/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe";
const sshArgs = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-p",
  "22022",
  "root@143.95.160.244",
];
const imageName =
  "4iuijgj7ocivevuow4yga8z7_api:b50ded1eae3149cbb796fca8ebf40a04b59a6c47";
const id = `sfverify-${Date.now()}-${randomBytes(3).toString("hex")}`;
const dir = resolve(".local", id);
mkdirSync(dir, { recursive: true });
const pg = `${id}-pg`,
  redis = `${id}-redis`,
  api = `${id}-api`,
  web = `${id}-web`;
const created = [];
let networkCreated = false;
const report = {
  startedAt: new Date().toISOString(),
  source: "Cloudflare R2 direct HTTPS GET",
  imageName,
  checks: [],
};
const started = Date.now();
let phase = "preflight";
function cmd(bin, args, options = {}) {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
    ...options,
  });
  if (r.status !== 0)
    throw new Error(`${phase}: command failed (exit ${r.status})`);
  return r.stdout.trim();
}
const d = (...args) => cmd(docker, args);
const sql = (text) =>
  cmd(
    docker,
    [
      "exec",
      "-i",
      pg,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "socialflow_migration",
      "-d",
      "socialflow",
    ],
    { input: text },
  );
function check(name, ok) {
  if (!ok) throw new Error(`Check failed: ${name}`);
  report.checks.push(name);
  console.log(`PASS ${name}`);
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady(test) {
  for (let i = 0; i < 60; i++) {
    try {
      if (test()) return;
    } catch {
      /* readiness retry */
    }
    await pause(1000);
  }
  throw new Error(`${phase}: readiness timeout`);
}
function runContainer(name, args, env = {}) {
  d("create", "--name", name, "--network", id, ...args);
  created.push(name);
  cmd(docker, ["start", name], { env: { ...process.env, ...env } });
}
async function acquireImage(imageName) {
  const imageId = cmd("ssh", [
    ...sshArgs,
    `docker image inspect ${imageName} --format '{{.Id}}'`,
  ]);
  check("Deployed image ID is valid", /^sha256:[a-f0-9]{64}$/.test(imageId));
  const local = spawnSync(
    docker,
    ["image", "inspect", imageId, "--format", "{{.Id}}"],
    { encoding: "utf8", windowsHide: true },
  );
  if (local.status !== 0) {
    console.log("Obtaining exact deployed image over SSH (read-only).");
    const source = spawn("ssh", [...sshArgs, `docker image save ${imageId}`], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const dest = spawn(docker, ["image", "load"], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const sourceEnd = once(source, "close"),
      destEnd = once(dest, "close");
    await pipeline(source.stdout, dest.stdin);
    const [[a], [b]] = await Promise.all([sourceEnd, destEnd]);
    check("Exact image transfer", a === 0 && b === 0);
  }
  check(
    "Local image matches VPS",
    d("image", "inspect", imageId, "--format", "{{.Id}}") === imageId,
  );
  return imageId;
}
try {
  phase = "image acquisition";
  const imageId = await acquireImage(imageName);
  report.imageId = imageId;
  report.webImageName = imageName.replace("_api:", "_web:");
  const webImageId = await acquireImage(report.webImageName);
  report.webImageId = webImageId;
  report.imageReadySeconds = (Date.now() - started) / 1000;
  phase = "R2 download";
  // Sign short-lived object GETs on the VPS; parent R2 credentials stay there.
  const links = cmd("ssh", [...sshArgs, "bash -s"], {
    input: `set -euo pipefail
source /root/.config/socialflow/backup.env
export RCLONE_CONFIG_SF_TYPE=s3 RCLONE_CONFIG_SF_PROVIDER=Cloudflare RCLONE_CONFIG_SF_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_SF_ENDPOINT="$R2_ENDPOINT" RCLONE_CONFIG_SF_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" RCLONE_CONFIG_SF_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
r2() { docker run --rm -e RCLONE_CONFIG_SF_TYPE -e RCLONE_CONFIG_SF_PROVIDER -e RCLONE_CONFIG_SF_NO_CHECK_BUCKET -e RCLONE_CONFIG_SF_ENDPOINT -e RCLONE_CONFIG_SF_ACCESS_KEY_ID -e RCLONE_CONFIG_SF_SECRET_ACCESS_KEY rclone/rclone:1.68.2 "$@"; }
name=$(r2 lsf "sf:$R2_BUCKET/$R2_PREFIX" --files-only | grep -E '^socialflow_backup_[0-9]{8}_[0-9]{6}\\.dump\\.gpg$' | sort | tail -n 1)
test -n "$name"
printf '%s\\n' "$name"
r2 link "sf:$R2_BUCKET/$R2_PREFIX/$name" --expire 10m
checksum=$(printf '%s' "$name" | sed 's/[.]dump[.]gpg$/.sha256/')
r2 link "sf:$R2_BUCKET/$R2_PREFIX/$checksum" --expire 10m
`,
  }).split(/\r?\n/);
  const [object, ...urls] = links;
  check(
    "Expected object and two signed GETs",
    /^socialflow_backup_\d{8}_\d{6}\.dump\.gpg$/.test(object) &&
      urls.length === 2,
  );
  report.object = object;
  const payloads = [];
  for (const link of urls) {
    const u = new URL(link);
    check(
      "Short-lived R2 HTTPS URL",
      u.protocol === "https:" &&
        u.hostname.endsWith(".r2.cloudflarestorage.com") &&
        Number(u.searchParams.get("X-Amz-Expires")) === 600,
    );
    const response = await fetch(link, {
      signal: AbortSignal.timeout(60000),
      redirect: "error",
    });
    check("Direct R2 GET succeeded", response.status === 200);
    payloads.push(Buffer.from(await response.arrayBuffer()));
  }
  const hash = createHash("sha256").update(payloads[0]).digest("hex");
  check(
    "Downloaded ciphertext SHA256 matches companion",
    payloads[1].toString().trim() === `${hash}  ${object}`,
  );
  report.sha256 = hash;
  report.bytes = payloads[0].length;
  writeFileSync(resolve(dir, "backup.gpg"), payloads[0], { mode: 0o600 });
  report.downloadFinishedSeconds = (Date.now() - started) / 1000;
  phase = "decryption";
  // Run GPG with a short, private ephemeral home. Never read the key in JS.
  cmd("C:/Program Files/Git/bin/bash.exe", ["-s"], {
    input: `set -euo pipefail
umask 077
GNUPGHOME=$(mktemp -d /tmp/sfgpg.XXXXXXXX)
export GNUPGHOME
trap 'gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT
gpg --batch --import .local/recovery/socialflow-recovery.sec.key >/dev/null 2>&1
gpg --batch --decrypt -o .local/${id}/restore.dump .local/${id}/backup.gpg >/dev/null 2>&1
`,
  });
  check(
    "GPG decrypted using operator key outside VPS",
    readFileSync(resolve(dir, "restore.dump")).length > 0,
  );
  phase = "isolated database";
  d("network", "create", "--internal", id);
  networkCreated = true;
  const admin = randomBytes(24).toString("hex"),
    runtime = randomBytes(24).toString("hex");
  // --tmpfs avoids anonymous/named data volumes; no host data ports are exposed.
  runContainer(pg, [
    "--tmpfs",
    "/var/lib/postgresql/data",
    "-e",
    `POSTGRES_PASSWORD=${admin}`,
    "-e",
    "POSTGRES_USER=socialflow_migration",
    "-e",
    "POSTGRES_DB=socialflow",
    "postgres:17.11-alpine",
  ]);
  await waitReady(() => {
    sql("SELECT 1;");
    return true;
  });
  // pg_isready can catch the temporary bootstrap server: require TCP readiness.
  await waitReady(() =>
    d(
      "exec",
      pg,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      "socialflow_migration",
      "-d",
      "socialflow",
    ).includes("accepting connections"),
  );
  sql(
    `CREATE ROLE socialflow_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD '${runtime}'; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO socialflow_runtime;`,
  );
  cmd(
    docker,
    [
      "exec",
      "-i",
      pg,
      "pg_restore",
      "-U",
      "socialflow_migration",
      "-d",
      "socialflow",
      "--no-owner",
      "--single-transaction",
      "--exit-on-error",
    ],
    { input: readFileSync(resolve(dir, "restore.dump")) },
  );
  phase = "restored invariants";
  check(
    "Every public table owned by migration",
    sql(
      "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner<>'socialflow_migration'",
    ) === "0",
  );
  check(
    "Runtime has no elevated role attributes or memberships",
    sql(
      "SELECT NOT (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication) AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) FROM pg_roles WHERE rolname='socialflow_runtime'",
    ) === "t",
  );
  check(
    "Five protected tables enforce RLS",
    sql(
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relname IN ('Brand','Client','Organization','Membership','AuditLog') AND relrowsecurity AND relforcerowsecurity",
    ) === "5",
  );
  for (const table of [
    "User",
    "Account",
    "Organization",
    "Membership",
    "Client",
    "Brand",
    "AuditLog",
  ]) {
    check(
      `Runtime restricted on ${table}`,
      sql(
        `SELECT has_table_privilege('socialflow_runtime','"${table}"','SELECT') AND NOT has_table_privilege('socialflow_runtime','"${table}"','DELETE,TRUNCATE,REFERENCES,TRIGGER')`,
      ) === "t",
    );
  }
  check(
    "Runtime cannot create public objects",
    sql(
      "SELECT has_schema_privilege('socialflow_runtime','public','CREATE')",
    ) === "f",
  );
  check(
    "No broad runtime default table grants",
    sql(
      "SELECT count(*) FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname='socialflow_runtime') AND a.privilege_type IN ('DELETE','TRUNCATE','TRIGGER')",
    ) === "0",
  );
  report.migrations = JSON.parse(
    sql(
      "SELECT json_agg(migration_name ORDER BY migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    ),
  );
  check(
    "Expected migrations",
    report.migrations.length === 4 &&
      report.migrations.includes("202609140001_brands"),
  );
  report.counts = JSON.parse(
    sql(
      `SELECT json_build_object('organizations',(SELECT count(*) FROM "Organization"),'users',(SELECT count(*) FROM "User"),'clients',(SELECT count(*) FROM "Client"),'brands',(SELECT count(*) FROM "Brand"),'auditLogs',(SELECT count(*) FROM "AuditLog"))`,
    ),
  );
  const baseline = sql(
    `SELECT md5(string_agg(row_to_json(u)::text,'' ORDER BY id)) FROM "User" u; SELECT md5(string_agg(row_to_json(a)::text,'' ORDER BY id)) FROM "Account" a;`,
  );
  const orgs = JSON.parse(
    sql(
      `SELECT json_agg(t) FROM (SELECT o.id AS org,c.id AS client FROM "Organization" o JOIN "Client" c ON c."organizationId"=o.id WHERE o.active AND c.active ORDER BY o.id,c.id) t`,
    ),
  );
  const orgA = orgs[0];
  check("Restored active organization/client available", !!orgA);
  let orgB = orgs.find((x) => x.org !== orgA.org);
  if (!orgB) {
    // The real dump may contain only one active tenant. Add an explicit
    // synthetic tenant only to this newly restored, disposable database.
    orgB = { org: `${id}-org-b`, client: `${id}-client-b` };
    sql(`INSERT INTO "Organization" (id,name,active,"createdAt") VALUES ('${orgB.org}','Recovery fixture B',true,now());
      INSERT INTO "Client" (id,"organizationId",name,slug,active,"createdAt") VALUES ('${orgB.client}','${orgB.org}','Recovery fixture client','recovery-fixture',true,now());`);
    report.secondOrganization = "synthetic fixture in isolated database";
  } else report.secondOrganization = "restored active organization";
  phase = "application";
  const redisPassword = randomBytes(24).toString("hex");
  runContainer(redis, [
    "--tmpfs",
    "/data",
    "redis:8.10.0-alpine",
    "redis-server",
    "--requirepass",
    redisPassword,
  ]);
  runContainer(api, [
    "-e",
    "NODE_ENV=production",
    "-e",
    "APP_URL=https://recovery-drill.invalid",
    "-e",
    `DATABASE_URL=postgresql://socialflow_runtime:${runtime}@${pg}:5432/socialflow`,
    "-e",
    `REDIS_URL=redis://:${redisPassword}@${redis}:6379`,
    "-e",
    `SESSION_SECRET=${randomBytes(32).toString("hex")}`,
    imageId,
  ]);
  await waitReady(
    () =>
      d(
        "exec",
        api,
        "node",
        "-e",
        "fetch('http://127.0.0.1:3001/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ) === "",
  );
  runContainer(web, ["-e", `API_INTERNAL_URL=http://${api}:3001`, webImageId]);
  await waitReady(
    () =>
      d(
        "exec",
        web,
        "node",
        "-e",
        "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ) === "",
  );
  check(
    "Restored frontend serves application page",
    d(
      "exec",
      web,
      "node",
      "-e",
      "fetch('http://127.0.0.1:3000/').then(async r=>{const s=await r.text();process.exit(r.ok&&s.includes('<html')?0:1)}).catch(()=>process.exit(1))",
    ) === "",
  );
  const password = randomBytes(24).toString("hex");
  const hashed = cmd(
    docker,
    [
      "exec",
      "-i",
      "-w",
      "/app/apps/api",
      api,
      "node",
      "--input-type=module",
      "-e",
      "import {hashPassword} from 'better-auth/crypto'; let s=''; for await(const c of process.stdin)s+=c; console.log(await hashPassword(s));",
    ],
    { input: password },
  );
  const quote = (s) => `'${s.replaceAll("'", "''")}'`;
  for (const [label, org] of [
    ["a", orgA],
    ["b", orgB],
  ]) {
    const uid = `${id}-${label}`;
    sql(
      `INSERT INTO "User" (id,name,email,active,"createdAt","updatedAt") VALUES (${quote(uid)},'Recovery verifier',${quote(uid + "@socialflow.test")},true,now(),now()); INSERT INTO "Account" (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES (${quote(uid)},${quote(uid)},'credential',${quote(uid)},${quote(hashed)},now(),now()); INSERT INTO "Membership" (id,"userId","organizationId",role,active) VALUES (${quote(uid)},${quote(uid)},${quote(org.org)},'ADMIN',true);`,
    );
  }
  const functional = cmd(
    docker,
    [
      "exec",
      "-i",
      api,
      "node",
      "--input-type=module",
      "-e",
      `
let raw=''; for await(const c of process.stdin)raw+=c; const {password,id,a,b}=JSON.parse(raw);
const base='http://${web}:3000'; const results=[];
async function req(path,cookie='',body){return fetch(base+path,{method:body?'POST':'GET',headers:{cookie,origin:'https://recovery-drill.invalid','content-type':'application/json'},body:body?JSON.stringify(body):undefined});}
async function expect(path,cookie,status){const r=await req(path,cookie);if(r.status!==status)throw Error('HTTP assertion'); results.push(status); return r;}
await expect('/health/ready','',200); await expect('/api/me','',401);
for(const [label,own,other] of [['a',a,b],['b',b,a]]){
const login=await req('/api/auth/sign-in/email','',{email:id+'-'+label+'@socialflow.test',password});if(login.status!==200)throw Error('Login failed');
const cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; '); if(!cookie)throw Error('No cookie');
const me=await (await expect('/api/me',cookie,200)).json();if(me.user.id!==id+'-'+label)throw Error('Identity mismatch');
const clients=await (await expect('/api/organizations/'+own.org+'/clients',cookie,200)).json();if(!clients.some(c=>c.id===own.client))throw Error('Restored client missing');
await expect('/api/organizations/'+own.org+'/clients/'+own.client+'/brands',cookie,200);
await expect('/api/organizations/'+other.org+'/clients',cookie,404);
await expect('/api/organizations/'+other.org+'/clients/'+other.client+'/brands',cookie,404);
} console.log(JSON.stringify(results));
`,
    ],
    { input: JSON.stringify({ password, id, a: orgA, b: orgB }) },
  );
  report.httpStatuses = JSON.parse(functional);
  check(
    "Real login and authorized/cross-organization HTTP access both directions",
    report.httpStatuses.length === 12,
  );
  const after = sql(
    `SELECT md5(string_agg(row_to_json(u)::text,'' ORDER BY id)) FROM "User" u WHERE id NOT LIKE '${id}%'; SELECT md5(string_agg(row_to_json(a)::text,'' ORDER BY id)) FROM "Account" a WHERE id NOT LIKE '${id}%';`,
  );
  check("Original restored users/accounts unchanged", baseline === after);
  report.recoveryThroughAuthenticatedWebSeconds = (Date.now() - started) / 1000;
  report.scope =
    "Exact API and web image acquisition + direct R2 download + decrypt + isolated database + invariants + API/web boot + authenticated HTTP validation through frontend proxy; excludes DNS/TLS cutover and incident detection.";
  report.status = "verified_web_api_recovery";
} catch (error) {
  report.status = "failed";
  report.failedPhase = phase;
  console.error(
    `Recovery failed during ${phase}. No secret-bearing diagnostics printed.`,
  );
  report.failure = error.message.startsWith("Check failed:")
    ? error.message
    : "Execution failed; inspect this phase without printing secrets.";
  process.exitCode = 1;
} finally {
  const cleanup = [];
  for (const name of created.reverse()) {
    const r = spawnSync(docker, ["rm", "-f", name], { windowsHide: true });
    cleanup.push(r.status === 0);
  }
  if (networkCreated)
    cleanup.push(
      spawnSync(docker, ["network", "rm", id], { windowsHide: true }).status ===
        0,
    );
  for (const name of ["restore.dump", "backup.gpg"]) {
    try {
      unlinkSync(resolve(dir, name));
    } catch (error) {
      if (error.code !== "ENOENT") cleanup.push(false);
    }
  }
  report.cleanupPassed = cleanup.every(Boolean);
  report.finishedAt = new Date().toISOString();
  writeFileSync(resolve(dir, "result.json"), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${resolve(dir, "result.json")}`);
  if (!report.cleanupPassed) process.exitCode = 1;
}
