import { Injectable, Inject } from '@nestjs/common';
import { DrizzleService } from '@oss/db';
import { EVENT_BUS, type EventBus } from '@oss/core';
// import { eq } from 'drizzle-orm';
// import { {{camel}} } from '../schema/index.js';

// Pure business logic for {{Name}}. Injected dependencies only; throws domain
// errors (createDomainError from @oss/core), never HTTP errors. Query via
// `this.drizzle.db.select().from(<table>)` with operators from 'drizzle-orm'.
@Injectable()
export class {{Name}}Service {
  constructor(
    private readonly drizzle: DrizzleService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  // AGENT: implement here - add the module's business methods below.
}
