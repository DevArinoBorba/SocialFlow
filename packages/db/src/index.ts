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
