import { Global, Module } from '@nestjs/common';
import { InMemoryEventBus, EVENT_BUS } from '@oss/core';
import { PrismaService } from '@oss/persistence';

// Global Nest module for platform infrastructure (DB, event bus).
// Registered before plugin modules so plugins can inject these.
@Global()
@Module({
  providers: [PrismaService, { provide: EVENT_BUS, useClass: InMemoryEventBus }],
  exports: [PrismaService, EVENT_BUS],
})
export class InfraModule {}
