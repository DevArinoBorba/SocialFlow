import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { createDatabase } from "./index.js";

// Offline, first-install operation. Never mounted as an HTTP endpoint.
export async function bootstrap(env: Record<string, string | undefined>) {
  const email = env.BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const name = env.BOOTSTRAP_NAME?.trim();
  const organization = env.BOOTSTRAP_ORGANIZATION?.trim();
  const password = env.BOOTSTRAP_PASSWORD;
  const url = env.MIGRATION_DATABASE_URL;
  if (
    env.ALLOW_INITIAL_BOOTSTRAP !== "true" ||
    !url ||
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !name ||
    name.length > 120 ||
    !organization ||
    organization.length > 120 ||
    !password ||
    password.length < 16 ||
    password.length > 128 ||
    /CHANGE_ME|GENERATE_|placeholder/i.test(password)
  )
    throw new Error(
      "Bootstrap requires explicit authorization and valid operator inputs",
    );
  if (new URL(url).username !== "socialflow_migration")
    throw new Error("Bootstrap requires the migration identity");
  const db = createDatabase(url);
  try {
    const hashed = await hashPassword(password);
    return await db.$transaction(async (tx) => {
      // Serializes competing bootstrap attempts; checking every identity avoids takeover.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(73401922)`;
      if ((await tx.user.count()) || (await tx.organization.count()))
        throw new Error(
          "Bootstrap refused: installation is already provisioned",
        );
      const userId = randomUUID();
      const organizationId = randomUUID();
      await tx.user.create({
        data: { id: userId, name, email, emailVerified: false },
      });
      await tx.account.create({
        data: {
          id: randomUUID(),
          userId,
          accountId: userId,
          providerId: "credential",
          password: hashed,
        },
      });
      await tx.organization.create({
        data: { id: organizationId, name: organization },
      });
      await tx.membership.create({
        data: { userId, organizationId, role: "OWNER" },
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: userId,
          entityId: organizationId,
          action: "installation.bootstrapped",
        },
      });
      return { userId, organizationId };
    });
  } finally {
    await db.$disconnect();
  }
}
