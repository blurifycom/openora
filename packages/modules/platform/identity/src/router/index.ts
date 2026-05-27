import { implement } from '@orpc/server';
import { type OssContext } from '@oss/core';
import { contract } from '@oss/orpc-contract';
import { IdentityService } from '../service/identity.service.js';

export function createIdentityRouter(identity: IdentityService) {
  const os = implement(contract.identity).$context<OssContext>();

  return os.router({
    register: os.register.handler(({ input, context }) =>
      identity.register(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    login: os.login.handler(({ input, context }) =>
      identity.login(input, context.request.headers, context.resHeaders ?? new Headers()),
    ),

    logout: os.logout.handler(({ context }) =>
      identity.logout(context.request.headers, context.resHeaders ?? new Headers()),
    ),

    me: os.me.handler(({ context }) => identity.me(context.request.headers)),
  });
}
