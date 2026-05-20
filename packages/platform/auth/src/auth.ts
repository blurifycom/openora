import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { organization } from 'better-auth/plugins';
import type { PrismaClient } from '@oss/persistence';

export type AuthOptions = {
  prisma: PrismaClient;
};

export function createAuth(options: AuthOptions) {
  return betterAuth({
    database: prismaAdapter(options.prisma, { provider: 'postgresql' }),
    emailAndPassword: { enabled: true },
    plugins: [organization()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
