// Tables owned by the {{Name}} module.
// This file is merged into infra/prisma/schema.prisma by `pnpm regen`.
// Rules:
//   - Every multi-tenant model must include: tenantId  String
//   - Use PascalCase singular model names
//   - Do not reference models owned by other modules directly; use IDs
//
// model {{Name}} {
//   id        String   @id @default(cuid())
//   tenantId  String
//   createdAt DateTime @default(now())
//   updatedAt DateTime @updatedAt
// }
