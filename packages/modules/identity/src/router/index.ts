import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@oss/orpc-contract';
import { IdentityService } from '../service/identity.service.js';
import type { Request, Response } from 'express';

type Ctx = { request: Request; response: Response };

@Controller()
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Implement(contract.identity)
  identityRoutes() {
    return {
      register: implement(contract.identity.register).handler(({ input, context }) => {
        const { request, response } = context as Ctx;
        return this.identity.register(input, request.headers as Record<string, string>, response);
      }),

      login: implement(contract.identity.login).handler(({ input, context }) => {
        const { request, response } = context as Ctx;
        return this.identity.login(input, request.headers as Record<string, string>, response);
      }),

      logout: implement(contract.identity.logout).handler(({ context }) => {
        const { request, response } = context as Ctx;
        return this.identity.logout(request.headers as Record<string, string>, response);
      }),

      me: implement(contract.identity.me).handler(({ context }) => {
        const { request } = context as Ctx;
        return this.identity.me(request.headers as Record<string, string>);
      }),
    };
  }
}
