import { os } from '@orpc/server';
import * as z from 'zod';
import type { TokenCatalog } from '@openora/core/contracts';
import type { InternalContext, OssContext } from '../../../kernel/index.js';
import type { Plugin } from '../../../plugin-host/define-plugin.js';
import { INTERNAL_API_SESSION_HEADERS } from '../../internal-api.js';

/** Calls per probe route, on globalThis: the host imports this file by path, not the test. */
export function internalProbeHits() {
  const holder = globalThis as { __internalProbeHits?: Record<string, number> };
  holder.__internalProbeHits ??= {};
  return holder.__internalProbeHits;
}

function hit(route: string) {
  const hits = internalProbeHits();
  hits[route] = (hits[route] ?? 0) + 1;
}

const internal = os.$context<InternalContext>();

const probe = {
  echo: internal
    .route({ method: 'POST', path: '/probe/echo' })
    .input(z.object({ amount: z.number() }))
    .handler(({ context, input }) => {
      hit('echo');
      return {
        caller: context.internalCaller,
        input,
        signedIn: context.auth !== undefined,
        sessionHeaders: INTERNAL_API_SESSION_HEADERS.filter(
          (name) => context.request.headers[name] !== undefined,
        ),
      };
    }),
  read: internal.route({ method: 'GET', path: '/probe/read' }).handler(({ context }) => {
    hit('read');
    return { caller: context.internalCaller };
  }),
  slow: internal.route({ method: 'POST', path: '/probe/slow' }).handler(async () => {
    hit('slow');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return { done: true };
  }),
  crash: internal.route({ method: 'POST', path: '/probe/crash' }).handler(() => {
    hit('crash');
    throw new Error('ledger unavailable');
  }),
};

// A public route that reports whether the runtime captured its raw body.
const rawBodyProbe = {
  raw: os
    .$context<OssContext>()
    .route({ method: 'POST', path: '/probe-raw' })
    .handler(({ context }) => ({ captured: context.rawBody !== undefined })),
};

export default {
  id: 'internal-probe',
  register(ctx) {
    ctx.routers.addInternal('probe', () => probe);
    ctx.routers.add('probeRaw', () => rawBodyProbe);
  },
} satisfies Plugin<TokenCatalog>;
