import { Controller, Module } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@oss/orpc-contract';

@Controller()
export class HealthController {
  @Implement(contract.health)
  health() {
    return {
      ping: implement(contract.health.ping).handler(() => ({
        status: 'ok' as const,
        timestamp: new Date().toISOString(),
      })),
    };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
