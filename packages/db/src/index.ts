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

export interface SchedulerActorScope {
  organizationId: string;
  clientId: string;
}

export interface RendererActorScope {
  organizationId: string;
  clientId: string;
}

// Scoped renderer actor. It intentionally has no membership and receives only
// the table-specific RLS capabilities granted to system:renderer.
export function asRendererActor<T>(
  db: PrismaClient,
  scope: RendererActorScope,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT set_config('app.user_id', 'system:renderer', true),
             set_config('app.renderer_org_id', ${scope.organizationId}, true),
             set_config('app.renderer_client_id', ${scope.clientId}, true)
    `;
    const client = await tx.client.findFirst({
      where: {
        id: scope.clientId,
        organizationId: scope.organizationId,
        active: true,
      },
      select: { id: true },
    });
    if (!client) {
      throw new Error(
        "Invalid or inactive tenant scope for renderer execution",
      );
    }
    return action(tx);
  });
}

// Scoped system execution actor: strictly isolated to organizationId and clientId, independent of creator user status.
export function asSchedulerActor<T>(
  db: PrismaClient,
  scope: SchedulerActorScope,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT set_config('app.user_id', 'system:scheduler', true),
             set_config('app.scheduler_org_id', ${scope.organizationId}, true),
             set_config('app.scheduler_client_id', ${scope.clientId}, true)
    `;
    const client = await tx.client.findFirst({
      where: {
        id: scope.clientId,
        organizationId: scope.organizationId,
        active: true,
      },
      select: { id: true },
    });
    if (!client) {
      throw new Error(
        "Invalid or inactive tenant scope for scheduler execution",
      );
    }
    return action(tx);
  });
}

export * from "./crypto.js";
