# Core concepts

Five ideas cover most of the platform. Every wiring point is an explicit, typed function call -
nothing is auto-discovered.

## Contracts

Every shape is a Zod schema; the type is inferred. oRPC turns a schema into a validated route
and OpenAPI - one source of truth for the server, the client, and the docs.

```ts
import { oc } from '@orpc/contract';
import * as z from 'zod';

export const DepositInputSchema = z.object({
  amount: z.number().positive(),
  currency: z.string(),
  provider: z.string().optional(),
});

export const walletContract = {
  getBalance: oc.route({ method: 'GET', path: '/wallet/balance' }).output(WalletBalanceSchema),
  deposit: oc
    .route({ method: 'POST', path: '/wallet/deposit' })
    .input(DepositInputSchema)
    .output(TransactionResultSchema),
};
```

## Services

A service holds the business logic. It takes its dependencies as constructor arguments (no
container access) and isolates side effects - DB writes, events, adapter calls - at the edges.

```ts
export class WalletService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly payment: PaymentAdapter,
  ) {}

  async deposit(userId: string, amount: number, currency: string): Promise<TransactionResult> {
    const psp = await this.payment.processDeposit(amount, currency, { userId });
    // ...persist in a transaction, then emit after commit
    this.events.emit('wallet.deposit.completed', { userId, amount, currency });
    return { transactionId: psp.id, status: 'completed' };
  }
}
```

## Routers

A router is thin oRPC wiring: resolve the caller, call the service, map errors. No business
rules live here.

```ts
import { implement } from '@orpc/server';
import { getUserId, mapErrors, type OssContext } from '@oss/core/server';
import { walletContract } from '../contract/index.js';

export function createWalletRouter(wallet: WalletService) {
  const os = implement(walletContract).$context<OssContext>();

  return os.router({
    getBalance: os.getBalance.handler(({ context }) => wallet.getBalance(getUserId(context))),
    deposit: os.deposit.handler(({ input, context }) =>
      wallet.deposit(getUserId(context), input.amount, input.currency),
    ),
  });
}
```

## Plugins

`definePlugin` is the only way new functionality enters the system. In `register(ctx)` you bind
adapters, add routers, subscribe to events, and register MCP tools.

```ts
import { definePlugin, EVENT_BUS, DRIZZLE } from '@oss/core/server';
import { PAYMENT_ADAPTER } from '@oss/core/contracts';
import { WalletService } from './service/wallet.service.js';
import { createWalletRouter } from './router/index.js';
import { MockPaymentAdapter } from './adapters/mock/mock-payment-adapter.js';

export default definePlugin({
  id: 'wallet',
  dependsOn: [], // optional load-order hints
  register(ctx) {
    ctx.provide(PAYMENT_ADAPTER, () => new MockPaymentAdapter());
    ctx.routers.add('wallet', (c) =>
      createWalletRouter(
        new WalletService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(PAYMENT_ADAPTER)),
      ),
    );
  },
});
```

## Ports & adapters

Third-party integrations (payments, KYC, messaging, realtime, jobs) are ports - an interface
plus a typed token. A module depends on the port; you bind any vendor in a plugin. Swap a vendor
by binding a different implementation in a later-loading overlay - no module change.

```ts
// default binding (ships in-tree)
ctx.provide(PAYMENT_ADAPTER, () => new MockPaymentAdapter());

// your overlay rebinds the same token to a real vendor
ctx.provide(PAYMENT_ADAPTER, () => new AcmePayments(env.ACME_KEY));
```

## Events

Modules stay decoupled by reacting to domain events, never importing each other's internals.
Declare the payload in the Zod catalog, emit after the DB commit, and subscribe in a plugin.

```ts
// emit from a service (after commit)
this.events.emit('wallet.deposit.completed', { userId, amount, currency });

// subscribe from a plugin
ctx.events.on('wallet.deposit.completed', (payload) => {
  // e.g. credit a first-deposit bonus
});
```

The same bus is a facade over a swappable message broker - in-process by default, a durable
broker (RabbitMQ/Kafka) via an overlay, with no module changes.

## Next

- [Architecture](/docs/architecture) - how these fit together.
- [API reference](/docs/api) - every route, generated from the live contract.
