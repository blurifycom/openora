import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { AdminGuard } from '@oss/auth';
import { mapErrors } from '@oss/core';
import { contract } from '@oss/orpc-contract';
import { BackofficeService, UserNotFoundError } from '../service/backoffice.service.js';

@Controller()
export class BackofficeController {
  constructor(
    private readonly backofficeService: BackofficeService,
    private readonly adminGuard: AdminGuard,
  ) {}

  @Implement(contract.backoffice)
  backofficeRouter() {
    return {
      getStats: implement(contract.backoffice.getStats).handler(async ({ context }) => {
        await this.adminGuard.assert(context);
        return this.backofficeService.getStats();
      }),

      listUsers: implement(contract.backoffice.listUsers).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context);
        return this.backofficeService.listUsers(input.page ?? 1, input.limit ?? 20, input.search);
      }),

      getUser: implement(contract.backoffice.getUser).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context);
        return mapErrors(
          { NOT_FOUND: UserNotFoundError },
          () => this.backofficeService.getUser(input.userId),
        );
      }),

      updateUser: implement(contract.backoffice.updateUser).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context);
        return mapErrors(
          { NOT_FOUND: UserNotFoundError },
          () => this.backofficeService.updateUser(input.userId, {
            isActive: input.isActive,
            role: input.role,
          }),
        );
      }),

      listTransactions: implement(contract.backoffice.listTransactions).handler(
        async ({ input, context }) => {
          await this.adminGuard.assert(context);
          return this.backofficeService.listTransactions(
            input.page ?? 1,
            input.limit ?? 20,
            input.userId,
          );
        },
      ),
    };
  }
}
