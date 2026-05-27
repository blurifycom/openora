import { DrizzleService } from '@oss/db';
import { type EventBus } from '@oss/core';
// import { eq } from 'drizzle-orm';
// import { {{camel}} } from '../schema/index.js';

// Pure business logic for {{Name}}. A plain class - the module's plugin.ts builds
// it via the composition container (no decorators). Throws domain errors
// (createDomainError from @oss/core), never HTTP errors. Query via
// `this.drizzle.db.select().from(<table>)` with operators from 'drizzle-orm'.
export class {{Name}}Service {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  // AGENT: implement here - add the module's business methods below.
}
