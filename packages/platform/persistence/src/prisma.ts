import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { PrismaClient };

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  const connectionString = databaseUrl ?? process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL env var is required');
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export async function setTenantId(prisma: PrismaClient, tenantId: string): Promise<void> {
  await prisma.$executeRawUnsafe('SET app.tenant_id = $1', tenantId);
}
