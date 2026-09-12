import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "./generated/client.js";
export { PrismaClient, Prisma };
export function createDatabase(url: string) {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url,
      max: 5,
      connectionTimeoutMillis: 2500,
      idleTimeoutMillis: 10000,
      statement_timeout: 5000,
    }),
  });
}
export async function assertRuntimeRole(db: PrismaClient) {
  const rows = await db.$queryRaw<{ safe: boolean }[]>`
    SELECT current_user = 'socialflow_runtime'
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb
      AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user))
      AS safe FROM pg_roles WHERE rolname = current_user`;
  if (!rows[0]?.safe) throw new Error("Unsafe database runtime identity");
}
// Never set session-wide context: a pooled connection can serve another actor next.
export function asActor<T>(
  db: PrismaClient,
  userId: string,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    const active = await tx.user.findFirst({
      where: { id: userId, active: true },
      select: { id: true },
    });
    if (!active) throw new Error("Inactive identity");
    return action(tx);
  });
}
