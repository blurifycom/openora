import { Global, Module } from '@nestjs/common';
import { InMemoryEventBus, EVENT_BUS } from '@oss/core';
import { DrizzleService } from '@oss/db';
import { AdminGuard } from '@oss/auth';

@Global()
@Module({
  providers: [DrizzleService, { provide: EVENT_BUS, useClass: InMemoryEventBus }, AdminGuard],
  exports: [DrizzleService, EVENT_BUS, AdminGuard],
})
export class InfraModule {}
