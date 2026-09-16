import { type DrizzleService, type EventBus } from '@openora/core/server';
import { gamification } from '../schema/index.js';

// Pure business logic for Gamification. A plain class wired by plugin.ts via
// the composition container (no decorators). Methods read as data-in/data-out
// transforms; isolate side effects (DB writes, event emits) at the edges. Throw
// domain errors (makeNotFoundError from @openora/core/server), never HTTP/transport errors.
// Money mutations MUST run inside `this.drizzle.db.transaction(...)` (lint: money-in-transaction).
export class GamificationService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  // Reference list method - the scaffolded `list` route delegates here. Replace the
  // projection / add filters as your domain needs. Selecting only contract fields
  // keeps the return type aligned with the output schema.
  async list() {
    const rows = await this.drizzle.db
      .select({ id: gamification.id, createdAt: gamification.createdAt })
      .from(gamification);
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  // AGENT: implement here - add the module's business methods below.
}
