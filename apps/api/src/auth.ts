import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { PrismaClient } from "@socialflow/db";
import type { Config } from "@socialflow/config";
export function createAuth(db: PrismaClient, config: Config) {
  return betterAuth({
    appName: "SocialFlow",
    baseURL: config.APP_URL,
    secret: config.SESSION_SECRET,
    trustedOrigins: [config.APP_URL],
    database: prismaAdapter(db, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
    },
    session: {
      expiresIn: 60 * 60 * 8,
      updateAge: 60 * 30,
      cookieCache: { enabled: false },
    },
    user: {
      additionalFields: {
        active: { type: "boolean", defaultValue: true, input: false },
      },
    },
    advanced: {
      useSecureCookies: config.NODE_ENV === "production",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: "database",
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await db.user.findFirst({
              where: { id: session.userId, active: true },
            });
            return user ? { data: session } : false;
          },
        },
      },
    },
    // Log stable event codes only: library diagnostics may include request data.
    logger: { disabled: true },
  });
}
