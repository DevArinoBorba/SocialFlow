import { hashPassword } from "better-auth/crypto";
import { createDatabase } from "./index.js";

export async function seed() {
  if (
    !["development", "test"].includes(process.env.NODE_ENV ?? "") ||
    process.env.ALLOW_DEV_SEED !== "true"
  )
    throw new Error(
      "Seed permitido somente em development/test com ALLOW_DEV_SEED=true",
    );
  const url = process.env.MIGRATION_DATABASE_URL;
  const password = process.env.DEV_SEED_PASSWORD;
  if (
    !url ||
    !password ||
    password.length < 12 ||
    /CHANGE_ME|GENERATE_/.test(password)
  )
    throw new Error(
      "Credencial de migration e senha de desenvolvimento >=12 caracteres obrigatórias",
    );
  const db = createDatabase(url);
  try {
    const hashed = await hashPassword(password);
    await db.$transaction(async (tx) => {
      for (const suffix of ["a", "b"]) {
        await tx.organization.upsert({
          where: { id: `org-${suffix}` },
          update: {},
          create: {
            id: `org-${suffix}`,
            name: `Agência ${suffix.toUpperCase()}`,
          },
        });
        await tx.client.upsert({
          where: { id: `client-${suffix}` },
          update: {},
          create: {
            id: `client-${suffix}`,
            organizationId: `org-${suffix}`,
            name: suffix === "a" ? "Café Central" : "Estúdio Horizonte",
            slug: `cliente-${suffix}`,
          },
        });
      }
      const profiles = [
        ["admin-a", "ADMIN", "a"],
        ["admin-b", "ADMIN", "b"],
        ["editor-a", "EDITOR", "a"],
        ["viewer-a", "CLIENT_VIEWER", "a"],
        ["approver-a", "APPROVER", "a"],
        ["owner-a", "OWNER", "a"],
      ] as const;
      for (const [id, role, suffix] of profiles) {
        await tx.user.upsert({
          where: { id },
          update: {},
          create: {
            id,
            name: id,
            email: `${id}@socialflow.test`,
            emailVerified: true,
          },
        });
        await tx.account.upsert({
          where: { id: `account-${id}` },
          update: {},
          create: {
            id: `account-${id}`,
            accountId: id,
            providerId: "credential",
            userId: id,
            password: hashed,
          },
        });
        await tx.membership.upsert({
          where: { id: `membership-${id}` },
          update: {},
          create: {
            id: `membership-${id}`,
            userId: id,
            organizationId: `org-${suffix}`,
            clientId: ["ADMIN", "OWNER"].includes(role)
              ? null
              : `client-${suffix}`,
            role,
          },
        });
      }
    });
    console.info(JSON.stringify({ event: "development_seed_completed" }));
  } finally {
    await db.$disconnect();
  }
}
await seed();
