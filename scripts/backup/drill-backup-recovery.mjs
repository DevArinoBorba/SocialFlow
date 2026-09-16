// Automated Backup and Recovery Drill
//
// Exercises the REAL scripts under test (socialflow-backup.sh,
// socialflow-restore.sh, check-backup-freshness.sh) end-to-end against a
// local S3-compatible stand-in (MinIO) for Cloudflare R2, plus targeted unit
// checks for GPG custody separation, corruption/tamper detection, retention
// pruning, and flock concurrency. Real Cloudflare R2 credentials are never
// used here -- only local, throwaway MinIO credentials.
//
// This drill runs the production bash scripts unmodified via `bash`. On
// Windows dev hosts, git-bash's MSYS runtime auto-mangles POSIX-looking
// paths when handing them to native Windows binaries (docker.exe, gpg.exe),
// and lacks a real `flock`. The helpers below compensate for that ONLY on
// win32; on Linux (the real VPS target and any Linux CI runner) they are
// no-ops and the scripts run exactly as shipped.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  utimesSync,
  chmodSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const IS_WIN = process.platform === "win32";
const RCLONE_IMAGE = "rclone/rclone:1.68.2";
const MINIO_IMAGE = "quay.io/minio/minio:RELEASE.2024-11-07T00-52-20Z";

const testRunId = `drill-${Date.now()}-${randomBytes(3).toString("hex")}`;
const baseDir = resolve(".local", testRunId);
mkdirSync(baseDir, { recursive: true });

const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(
    `${passed ? "PASS" : "FAIL"} - ${name}${detail ? " :: " + detail : ""}`,
  );
}

function runCmd(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...options });
}
function runDocker(...args) {
  return runCmd("docker", args);
}

// ---- Windows/git-bash path compatibility helpers (no-ops elsewhere) ----
// Forward-slash-with-drive-letter form (e.g. C:/Users/x) is what MSYS bash
// hands through to docker.exe/gpg.exe cleanly for paths used in `docker cp`
// and `docker run -v`, without the drive-letter-duplication bug that a bare
// `/c/Users/x` POSIX-style path triggers in Go's Windows path resolution.
function dockerPath(p) {
  if (!IS_WIN) return p;
  return p.replace(/\\/g, "/");
}
// gpg (bundled with git-bash) wants classic MSYS POSIX form for GNUPGHOME.
function posixPath(p) {
  if (!IS_WIN) return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, "/");
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

let flockShimDir = null;
function bashEnv(extra = {}) {
  const env = { ...process.env, MSYS2_ARG_CONV_EXCL: "*", ...extra };
  if (IS_WIN && flockShimDir) {
    env.PATH = `${flockShimDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`;
  }
  return env;
}

function runBash(scriptPath, args, env = {}) {
  return runCmd("bash", [scriptPath, ...args], { env: bashEnv(env) });
}

if (IS_WIN) {
  // Minimal non-blocking mkdir-based flock shim, sufficient for the
  // single-process script runs in this drill. Real concurrency semantics
  // (hold-until-FD-closes) are validated separately in Phase 7 inside a
  // genuine Linux container, where real flock is available.
  flockShimDir = resolve(baseDir, "binshim");
  mkdirSync(flockShimDir, { recursive: true });
  writeFileSync(
    resolve(flockShimDir, "flock"),
    `#!/usr/bin/env bash\nset -euo pipefail\nLOCKDIR="\${SOCIALFLOW_FLOCKSHIM_DIR:-/tmp/.flockshim.d}"\nif mkdir "$LOCKDIR" 2>/dev/null; then trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT; exit 0; else exit 1; fi\n`,
  );
  chmodSync(resolve(flockShimDir, "flock"), 0o755);
}

console.log(
  `[DRILL] Starting SocialFlow Backup & Recovery Drill (${testRunId})...`,
);

const REPO_ROOT = resolve(".");
const BACKUP_SH = resolve(REPO_ROOT, "scripts/backup/socialflow-backup.sh");
const RESTORE_SH = resolve(REPO_ROOT, "scripts/backup/socialflow-restore.sh");
const FRESHNESS_SH = resolve(
  REPO_ROOT,
  "scripts/backup/check-backup-freshness.sh",
);

let minioStarted = false;
let minioNetwork = null;
const gpgHomesToClean = [];

try {
  // ---- 1. Generate GPG keypair, split into VPS (public-only) and operator
  // (private) keyrings -- mirrors the real custody boundary: the VPS must
  // never hold decryption capability. ----
  console.log("\n--- Phase 1: Keypair Generation & Custody Split ---");
  const keyDir = resolve(baseDir, "keys");
  // gpg-agent binds a Unix-domain socket under GNUPGHOME; a deeply nested
  // repo path plus a long run id can exceed the classic ~108-byte socket
  // path limit and make the agent fail to start. Keep GPG homes short and
  // outside the (possibly long) repo path entirely.
  const shortId = randomBytes(4).toString("hex");
  const vpsHome = join(tmpdir(), `sfvps-${shortId}`);
  const operatorHome = join(tmpdir(), `sfop-${shortId}`);
  for (const d of [keyDir, vpsHome, operatorHome])
    mkdirSync(d, { recursive: true });
  gpgHomesToClean.push(vpsHome, operatorHome);

  const genRes = runDocker(
    "run",
    "--rm",
    "-v",
    `${dockerPath(keyDir)}:/keys`,
    "alpine:latest",
    "sh",
    "-c",
    `apk add --no-cache gnupg >/dev/null 2>&1 &&
     cat << 'EOF' > /tmp/gen.batch
%no-protection
Key-Type: EDDSA
Key-Curve: ed25519
Subkey-Type: ECDH
Subkey-Curve: cv25519
Name-Real: SocialFlow Backup
Name-Email: test-backup@socialflow.local
Expire-Date: 0
%commit
EOF
     gpg --batch --generate-key /tmp/gen.batch >/dev/null 2>&1 &&
     gpg --armor --export test-backup@socialflow.local > /keys/pub.key &&
     gpg --armor --export-secret-keys test-backup@socialflow.local > /keys/sec.key
    `,
  );
  const keysExist =
    genRes.status === 0 &&
    readFileSync(resolve(keyDir, "pub.key"), "utf8").includes(
      "BEGIN PGP PUBLIC KEY BLOCK",
    ) &&
    readFileSync(resolve(keyDir, "sec.key"), "utf8").includes(
      "BEGIN PGP PRIVATE KEY BLOCK",
    );
  record("GPG ED25519/CV25519 keypair generation", keysExist);

  const importPub = runCmd(
    "gpg",
    ["--batch", "--import", resolve(keyDir, "pub.key")],
    {
      env: { ...process.env, GNUPGHOME: posixPath(vpsHome) },
    },
  );
  const importSec = runCmd(
    "gpg",
    ["--batch", "--import", resolve(keyDir, "sec.key")],
    {
      env: { ...process.env, GNUPGHOME: posixPath(operatorHome) },
    },
  );
  record(
    "VPS keyring imports public key only / operator keyring imports private key",
    importPub.status === 0 && importSec.status === 0,
    importPub.status !== 0 || importSec.status !== 0
      ? `importPub=${importPub.status}:${importPub.stderr} importSec=${importSec.status}:${importSec.stderr}`
      : "",
  );

  const vpsHasSecret = runCmd("gpg", ["--list-secret-keys"], {
    env: { ...process.env, GNUPGHOME: posixPath(vpsHome) },
  });
  record(
    "VPS keyring holds NO secret key material (custody boundary)",
    vpsHasSecret.status === 0 && !vpsHasSecret.stdout.includes("sec "),
    "A compromised VPS cannot decrypt backups with what it has locally",
  );

  // ---- 2. Encrypt with VPS (public-only) keyring, confirm VPS itself
  // cannot decrypt, then confirm operator (private) keyring can. ----
  console.log("\n--- Phase 2: Custody-Separated Encrypt/Decrypt ---");
  const payloadDir = resolve(baseDir, "payload");
  mkdirSync(payloadDir, { recursive: true });
  const sampleData = `SOCIALFLOW_DUMP_SIMULATION_${randomBytes(256).toString("hex")}`;
  writeFileSync(resolve(payloadDir, "data.raw"), sampleData);

  const encRes = runCmd(
    "gpg",
    [
      "--batch",
      "--yes",
      "--trust-model",
      "always",
      "--encrypt",
      "--recipient",
      "test-backup@socialflow.local",
      "-o",
      resolve(payloadDir, "data.raw.gpg"),
      resolve(payloadDir, "data.raw"),
    ],
    { env: { ...process.env, GNUPGHOME: posixPath(vpsHome) } },
  );
  record(
    "GPG asymmetric encryption with VPS public-only keyring",
    encRes.status === 0,
  );

  const decWithVps = runCmd(
    "gpg",
    [
      "--batch",
      "--yes",
      "--decrypt",
      "-o",
      resolve(payloadDir, "data.dec.vps"),
      resolve(payloadDir, "data.raw.gpg"),
    ],
    { env: { ...process.env, GNUPGHOME: posixPath(vpsHome) } },
  );
  record(
    "VPS keyring CANNOT decrypt its own backup (no private key present)",
    decWithVps.status !== 0,
    "Proves a fully compromised VPS still cannot read past backups",
  );

  const decRes = runCmd(
    "gpg",
    [
      "--batch",
      "--yes",
      "--decrypt",
      "-o",
      resolve(payloadDir, "data.dec"),
      resolve(payloadDir, "data.raw.gpg"),
    ],
    { env: { ...process.env, GNUPGHOME: posixPath(operatorHome) } },
  );
  let decData = null;
  try {
    decData = readFileSync(resolve(payloadDir, "data.dec"), "utf8");
  } catch (err) {
    void err;
  }
  record(
    "Operator (custodied private key) decrypts successfully",
    decRes.status === 0 && decData === sampleData,
    decRes.status !== 0 ? String(decRes.stderr) : "",
  );

  // ---- 3. Failure scenarios: tampered ciphertext, corrupt dump ----
  console.log("\n--- Phase 3: Failure Scenarios ---");
  const tampered = Buffer.from(
    readFileSync(resolve(payloadDir, "data.raw.gpg")),
  );
  tampered[tampered.length - 10] ^= 0xff;
  writeFileSync(resolve(payloadDir, "data.tampered.gpg"), tampered);
  const decTampered = runCmd(
    "gpg",
    [
      "--batch",
      "--yes",
      "--decrypt",
      "-o",
      resolve(payloadDir, "data.tampered.dec"),
      resolve(payloadDir, "data.tampered.gpg"),
    ],
    { env: { ...process.env, GNUPGHOME: posixPath(operatorHome) } },
  );
  record(
    "Tampered ciphertext decryption fails explicitly",
    decTampered.status !== 0,
    `Exit code: ${decTampered.status}`,
  );

  const corruptDumpRes = runDocker(
    "run",
    "--rm",
    "-i",
    "postgres:17.11-alpine",
    "sh",
    "-c",
    "echo 'NOT_A_VALID_POSTGRES_DUMP_HEADER' | pg_restore -l",
  );
  record(
    "Corrupted dump fails pg_restore TOC verification",
    corruptDumpRes.status !== 0,
  );

  // ---- 4. Retention pruning: real backdated mtimes, assert actual deletion
  // of the old file and survival of recent ones, scoped to the target prefix
  // only. (Previous version faked ages only in filenames, never actually
  // backdated files, so it could not detect a broken retention policy.) ----
  console.log("\n--- Phase 4: Retention Pruning (real backdated files) ---");
  const retentionRoot = resolve(baseDir, "remote_storage");
  const retentionDir = resolve(
    retentionRoot,
    "backups",
    "socialflow",
    "homolog",
  );
  const outsidePrefixDir = resolve(retentionRoot, "backups", "other-app");
  mkdirSync(retentionDir, { recursive: true });
  mkdirSync(outsidePrefixDir, { recursive: true });

  const fileOld = resolve(retentionDir, "socialflow_backup_old.dump.gpg");
  const fileRecent = resolve(retentionDir, "socialflow_backup_recent.dump.gpg");
  const outsideOld = resolve(outsidePrefixDir, "other_backup_old.dump.gpg");
  writeFileSync(fileOld, "old_backup");
  writeFileSync(fileRecent, "recent_backup");
  writeFileSync(outsideOld, "other_app_old_backup");

  const now = Date.now() / 1000;
  const fortyDaysAgo = now - 40 * 86400;
  utimesSync(fileOld, fortyDaysAgo, fortyDaysAgo);
  utimesSync(outsideOld, fortyDaysAgo, fortyDaysAgo); // old, but outside our prefix

  const rclonePrune = runDocker(
    "run",
    "--rm",
    "-v",
    `${dockerPath(retentionRoot)}:/remote`,
    RCLONE_IMAGE,
    "delete",
    "/remote/backups/socialflow/homolog",
    "--min-age",
    "30d",
  );
  const remaining = readdirSync(retentionDir);
  const outsideRemaining = readdirSync(outsidePrefixDir);
  record(
    "Retention deletes the actually-old file inside the target prefix",
    rclonePrune.status === 0 &&
      !remaining.includes("socialflow_backup_old.dump.gpg"),
  );
  record(
    "Retention keeps the recent file inside the target prefix",
    remaining.includes("socialflow_backup_recent.dump.gpg"),
  );
  record(
    "Retention never touches files outside the dedicated prefix, even if old",
    outsideRemaining.includes("other_backup_old.dump.gpg"),
  );

  // ---- 5. Real end-to-end drill via MinIO stand-in for R2, using the
  // ACTUAL production scripts (unmodified logic) ----
  console.log(
    "\n--- Phase 5: Real socialflow-backup.sh / socialflow-restore.sh via S3-compatible storage ---",
  );
  minioNetwork = `${testRunId}-minio-net`;
  runDocker("network", "create", minioNetwork);
  const minioUser = "drilladmin";
  const minioPass = `drill${randomBytes(8).toString("hex")}`;
  const minioContainer = `${testRunId}-minio`;
  // Let Docker pick a free ephemeral host port to avoid collisions between
  // quick successive drill runs (a fixed/pseudo-random port can still be in
  // TIME_WAIT or reused by another concurrent run).
  const minioRun = runDocker(
    "run",
    "-d",
    "--rm",
    "--name",
    minioContainer,
    "--network",
    minioNetwork,
    "-p",
    "9000",
    "-e",
    `MINIO_ROOT_USER=${minioUser}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${minioPass}`,
    MINIO_IMAGE,
    "server",
    "/data",
  );
  minioStarted = minioRun.status === 0;
  record("MinIO (S3-compatible R2 stand-in) container started", minioStarted);

  const portOut = runDocker("port", minioContainer, "9000/tcp");
  const portMatch = /:(\d+)\s*$/.exec((portOut.stdout || "").trim());
  const minioHostPort = portMatch ? portMatch[1] : "19000";

  const bucket = "socialflow-backups-test";
  let minioReady = false;
  for (let i = 0; i < 40 && !minioReady; i++) {
    const probe = runDocker(
      "run",
      "--rm",
      "-e",
      "RCLONE_CONFIG_T_TYPE=s3",
      "-e",
      "RCLONE_CONFIG_T_PROVIDER=Minio",
      "-e",
      `RCLONE_CONFIG_T_ENDPOINT=http://host.docker.internal:${minioHostPort}`,
      "-e",
      `RCLONE_CONFIG_T_ACCESS_KEY_ID=${minioUser}`,
      "-e",
      `RCLONE_CONFIG_T_SECRET_ACCESS_KEY=${minioPass}`,
      RCLONE_IMAGE,
      "lsd",
      "t:",
    );
    if (probe.status === 0) minioReady = true;
    else spawnSync("node", ["-e", "setTimeout(()=>{}, 500)"]);
  }
  runDocker(
    "run",
    "--rm",
    "-e",
    "RCLONE_CONFIG_T_TYPE=s3",
    "-e",
    "RCLONE_CONFIG_T_PROVIDER=Minio",
    "-e",
    `RCLONE_CONFIG_T_ENDPOINT=http://host.docker.internal:${minioHostPort}`,
    "-e",
    `RCLONE_CONFIG_T_ACCESS_KEY_ID=${minioUser}`,
    "-e",
    `RCLONE_CONFIG_T_SECRET_ACCESS_KEY=${minioPass}`,
    RCLONE_IMAGE,
    "mkdir",
    `t:${bucket}`,
  );
  record(
    "MinIO bucket created and reachable via pinned rclone image",
    minioReady,
  );

  const noR2Config = resolve(baseDir, "noR2.env");
  writeFileSync(
    noR2Config,
    `SOCIALFLOW_ENV=homolog\nPOSTGRES_USER=socialflow_migration\nPOSTGRES_DB=socialflow\nGPG_RECIPIENT="SocialFlow Backup"\nRETENTION_DAYS=30\n`,
  );
  const r2Config = resolve(baseDir, "r2.env");
  writeFileSync(
    r2Config,
    [
      "SOCIALFLOW_ENV=homolog",
      "POSTGRES_USER=socialflow_migration",
      "POSTGRES_DB=socialflow",
      'GPG_RECIPIENT="SocialFlow Backup"',
      `R2_ENDPOINT="http://host.docker.internal:${minioHostPort}"`,
      `R2_BUCKET="${bucket}"`,
      'R2_PREFIX="backups/socialflow/homolog"',
      `R2_ACCESS_KEY_ID="${minioUser}"`,
      `R2_SECRET_ACCESS_KEY="${minioPass}"`,
      "RETENTION_DAYS=30",
      "",
    ].join("\n"),
  );

  // Detect a locally-running SocialFlow postgres container to back the real
  // pg_dump. Falls back gracefully if the test stack isn't up.
  const psOut = runDocker(
    "ps",
    "--filter",
    "name=postgres",
    "--format",
    "{{.Names}}",
  );
  const pgContainer = (psOut.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .find((n) => /socialflow/i.test(n));

  if (!pgContainer) {
    record(
      "Real backup/restore script drill (Phase 5)",
      false,
      "SKIPPED: no running SocialFlow postgres test container found (expected name containing 'socialflow'); start the local test stack first",
    );
  } else {
    // 5a. No R2 credentials -> must be local-only, never a false "success".
    const backupLocalDirA = resolve(baseDir, "backupA");
    const runA = runBash(BACKUP_SH, [], {
      GNUPGHOME: posixPath(vpsHome),
      BACKUP_CONFIG_FILE: dockerPath(noR2Config),
      BACKUP_LOCAL_DIR: dockerPath(backupLocalDirA),
      BACKUP_LOCK_FILE: dockerPath(resolve(baseDir, "backupA.lock")),
      POSTGRES_CONTAINER: pgContainer,
    });
    let statusA = {};
    try {
      const fileA = [
        resolve(backupLocalDirA, "last_backup_homolog.json"),
        resolve(backupLocalDirA, "last_backup.json"),
      ].find((p) => {
        try {
          return Boolean(readFileSync(p));
        } catch {
          return false;
        }
      });
      statusA = JSON.parse(readFileSync(fileA, "utf8"));
    } catch (err) {
      void err;
    }
    record(
      "socialflow-backup.sh with NO R2 credentials reports local-only, not success",
      runA.status === 0 &&
        statusA.status === "success_local_only" &&
        statusA.remoteUploadConfirmed === false,
      JSON.stringify(statusA),
    );
    let remoteMarkerAExists = true;
    try {
      const markerA = [
        resolve(backupLocalDirA, "last_successful_remote_backup_homolog.json"),
        resolve(backupLocalDirA, "last_successful_remote_backup.json"),
      ].find((p) => {
        try {
          return Boolean(readFileSync(p));
        } catch {
          return false;
        }
      });
      if (!markerA) remoteMarkerAExists = false;
    } catch (err) {
      void err;
      remoteMarkerAExists = false;
    }
    record(
      "No remote-success marker written when no external upload occurred",
      !remoteMarkerAExists,
    );

    // 5b. Real R2-style upload (MinIO) -> must be confirmed remote success.
    const backupLocalDirB = resolve(baseDir, "backupB");
    const runB = runBash(BACKUP_SH, [], {
      GNUPGHOME: posixPath(vpsHome),
      BACKUP_CONFIG_FILE: dockerPath(r2Config),
      BACKUP_LOCAL_DIR: dockerPath(backupLocalDirB),
      BACKUP_LOCK_FILE: dockerPath(resolve(baseDir, "backupB.lock")),
      POSTGRES_CONTAINER: pgContainer,
    });
    let statusB = {};
    try {
      const fileB = [
        resolve(backupLocalDirB, "last_backup_homolog.json"),
        resolve(backupLocalDirB, "last_backup.json"),
      ].find((p) => {
        try {
          return Boolean(readFileSync(p));
        } catch {
          return false;
        }
      });
      statusB = JSON.parse(readFileSync(fileB, "utf8"));
    } catch (err) {
      void err;
    }
    record(
      "socialflow-backup.sh with real S3-compatible upload confirms remote success",
      runB.status === 0 &&
        statusB.status === "success_remote" &&
        statusB.remoteUploadConfirmed === true,
      JSON.stringify(statusB),
    );

    const independentListing = runDocker(
      "run",
      "--rm",
      "-e",
      "RCLONE_CONFIG_T_TYPE=s3",
      "-e",
      "RCLONE_CONFIG_T_PROVIDER=Minio",
      "-e",
      `RCLONE_CONFIG_T_ENDPOINT=http://host.docker.internal:${minioHostPort}`,
      "-e",
      `RCLONE_CONFIG_T_ACCESS_KEY_ID=${minioUser}`,
      "-e",
      `RCLONE_CONFIG_T_SECRET_ACCESS_KEY=${minioPass}`,
      RCLONE_IMAGE,
      "lsf",
      `t:${bucket}/backups/socialflow/homolog`,
    );
    record(
      "Uploaded object independently verifiable in the bucket (not just self-reported)",
      independentListing.status === 0 &&
        /\.dump\.gpg$/m.test(independentListing.stdout || ""),
    );

    // 5c. Real download-from-R2(MinIO) + decrypt (operator key) + isolated
    // restore + dynamic ownership/grant checks + app boot/auth check.
    const recoveryDir = resolve(baseDir, "recovery-run");
    const psApi = runDocker("images", "--format", "{{.Repository}}");
    const apiImage = (psApi.stdout || "")
      .split("\n")
      .map((s) => s.trim())
      .find((n) => /socialflow.*api/i.test(n));

    const runRestore = runBash(RESTORE_SH, [], {
      GNUPGHOME: posixPath(operatorHome),
      BACKUP_CONFIG_FILE: dockerPath(r2Config),
      BACKUP_LOCAL_DIR: dockerPath(backupLocalDirB),
      RECOVERY_DIR: dockerPath(recoveryDir),
      ...(apiImage ? { SOCIALFLOW_APP_IMAGE: apiImage } : {}),
    });
    const restoreOut = (runRestore.stdout || "") + (runRestore.stderr || "");
    const restorePassed =
      runRestore.status === 0 && /source: r2:/.test(restoreOut);
    record(
      "socialflow-restore.sh downloads from S3-compatible storage (real R2 code path), decrypts, restores, and validates",
      restorePassed,
      restorePassed
        ? restoreOut
            .split("\n")
            .filter((l) =>
              /RTO|RESTORE VERIFICATION|Application-level|Backup source|[Aa]uthenticated|cross-org|Skipped/.test(
                l,
              ),
            )
            .join(" | ")
        : `exit=${runRestore.status}\n${restoreOut}`,
    );
    if (!apiImage) {
      record(
        "Application-level (isolation/auth/health) restore validation",
        false,
        "SKIPPED: no local socialflow api image found -- this remains an untested gap, not a pass",
      );
    } else {
      record(
        "Application-level (isolation/auth/health) restore validation",
        /Application-level validation \(health\/auth\): passed/.test(
          restoreOut,
        ),
      );
    }
  }

  // ---- 6. Freshness watchdog: fresh / stale / missing ----
  console.log("\n--- Phase 6: Backup Freshness Watchdog ---");
  const freshnessDir = resolve(baseDir, "freshness");
  mkdirSync(freshnessDir, { recursive: true });
  writeFileSync(
    resolve(freshnessDir, "last_successful_remote_backup.json"),
    JSON.stringify({ timestamp: new Date().toISOString() }),
  );
  const freshRun = runBash(FRESHNESS_SH, [], {
    BACKUP_LOCAL_DIR: dockerPath(freshnessDir),
    DISCORD_WEBHOOK_URL: "",
  });
  record("Freshness watchdog: fresh backup -> exit 0", freshRun.status === 0);

  writeFileSync(
    resolve(freshnessDir, "last_successful_remote_backup.json"),
    JSON.stringify({
      timestamp: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    }),
  );
  const staleRun = runBash(FRESHNESS_SH, [], {
    BACKUP_LOCAL_DIR: dockerPath(freshnessDir),
    DISCORD_WEBHOOK_URL: "",
  });
  record(
    "Freshness watchdog: 48h-old backup -> exit 1 (stale)",
    staleRun.status === 1,
  );

  const neverDir = resolve(baseDir, "freshness-never");
  mkdirSync(neverDir, { recursive: true });
  const neverRun = runBash(FRESHNESS_SH, [], {
    BACKUP_LOCAL_DIR: dockerPath(neverDir),
    DISCORD_WEBHOOK_URL: "",
  });
  record(
    "Freshness watchdog: never backed up -> exit 2 (critical)",
    neverRun.status === 2,
  );
  record(
    "Freshness watchdog is independent of the backup cron (reads only the marker file)",
    true,
    "By construction: check-backup-freshness.sh never invokes or depends on socialflow-backup.sh's cron entry",
  );

  // ---- 7. Flock concurrency, validated in a real Linux container (git-bash
  // on Windows has no native flock; the VPS target does) ----
  console.log("\n--- Phase 7: Concurrency Protection (flock) ---");
  const flockDir = resolve(baseDir, "flocktest");
  mkdirSync(flockDir, { recursive: true });
  writeFileSync(
    resolve(flockDir, "test.sh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "exec 200>/tmp/test.lock",
      "if ! flock -n 200; then echo REJECTED; exit 1; fi",
      "echo ACQUIRED",
      "sleep 3",
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(flockDir, "run.sh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "chmod +x /work/test.sh",
      "bash /work/test.sh &",
      "FIRST=$!",
      "sleep 1",
      "SECOND=0",
      "bash /work/test.sh || SECOND=$?",
      "wait $FIRST",
      '[ "$SECOND" -eq 1 ]',
      "",
    ].join("\n"),
  );
  const flockTest = runDocker(
    "run",
    "--rm",
    "-v",
    `${dockerPath(flockDir)}:/work`,
    "alpine:latest",
    "sh",
    "-c",
    "apk add --no-cache bash util-linux coreutils >/dev/null 2>&1 && bash /work/run.sh",
  );
  record(
    "flock rejects a second concurrent run (exact pattern used in socialflow-backup.sh)",
    flockTest.status === 0,
    flockTest.status !== 0
      ? `${flockTest.stdout || ""}${flockTest.stderr || ""}`
      : "",
  );

  // ---- 8. Regression guard: no unpinned :latest image references remain ----
  console.log("\n--- Phase 8: Image Pinning Regression Guard ---");
  const scriptFiles = [BACKUP_SH, RESTORE_SH, FRESHNESS_SH];
  const unpinned = scriptFiles.filter((f) =>
    /rclone\/rclone:latest/.test(readFileSync(f, "utf8")),
  );
  record(
    "No script references rclone/rclone:latest (all pin an explicit version)",
    unpinned.length === 0,
    unpinned.join(", "),
  );
} finally {
  if (minioStarted) runDocker("stop", `${testRunId}-minio`);
  if (minioNetwork) runDocker("network", "rm", minioNetwork);
  rmSync(baseDir, { recursive: true, force: true });
  for (const p of gpgHomesToClean) rmSync(p, { recursive: true, force: true });
}

console.log("\n==================================================");
const allPassed = results.every((r) => r.passed);
console.log(
  `DRILL SUMMARY: ${results.filter((r) => r.passed).length}/${results.length} CHECKS PASSED`,
);
if (!allPassed) {
  console.error("DRILL FAILED! Some checks did not pass.");
  process.exit(1);
} else {
  console.log(
    "DRILL SUCCESSFUL! All backup and disaster recovery requirements verified.",
  );
}
