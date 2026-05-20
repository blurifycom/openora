import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { ORPCError } from '@orpc/server';
import { contract } from '@oss/orpc-contract';
import { BackofficeService, UserNotFoundError } from '../service/backoffice.service.js';

@Controller()
export class BackofficeController {
  constructor(private readonly backofficeService: BackofficeService) {}

  @Implement(contract.backoffice)
  backofficeRouter() {
    return {
      getStats: implement(contract.backoffice.getStats).handler(() =>
        this.backofficeService.getStats(),
      ),

      listUsers: implement(contract.backoffice.listUsers).handler(({ input }) =>
        this.backofficeService.listUsers(input.page ?? 1, input.limit ?? 20, input.search),
      ),

      getUser: implement(contract.backoffice.getUser).handler(async ({ input }) => {
        try {
          return await this.backofficeService.getUser(input.userId);
        } catch (err) {
          if (err instanceof UserNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          throw err;
        }
      }),

      updateUser: implement(contract.backoffice.updateUser).handler(async ({ input }) => {
        try {
          return await this.backofficeService.updateUser(input.userId, {
            isActive: input.isActive,
            role: input.role,
          });
        } catch (err) {
          if (err instanceof UserNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          throw err;
        }
      }),

      listTransactions: implement(contract.backoffice.listTransactions).handler(({ input }) =>
        this.backofficeService.listTransactions(input.page ?? 1, input.limit ?? 20, input.userId),
      ),
    };
  }
}
