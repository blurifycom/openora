# Core concepts

Five ideas cover most of the platform. Every wiring point is an explicit, typed function call -
nothing is auto-discovered.

## Contracts

Every shape is a Zod schema; the type is inferred. oRPC turns a schema into a validated route
and OpenAPI - one source of truth for the server, the client, and the docs.

The wallet contract (`packages/core/src/wallet/contract/index.ts`) is the model. A Zod schema such
as `DepositInputSchema` (a positive amount, a currency, an optional provider) is bound to an oRPC
route with `oc.route` from `@orpc/contract`, giving each route a method and path (for example
`GET /wallet/balance` and `POST /wallet/deposit`), an `.input` schema and an `.output` schema.

## Services

A service holds the business logic. It takes its dependencies as constructor arguments (no
container access) and isolates side effects - DB writes, events, adapter calls - at the edges.

`WalletService` in `packages/core/src/wallet/service/wallet.service.ts` is the model. Its
constructor takes `DrizzleService`, `EventBus` and a `PaymentAdapter`. `deposit` calls the payment
adapter's `processDeposit`, then in one database transaction persists the ledger row and balance and
writes `wallet.deposit.completed` with `emitInTransaction`, so the money event commits with the
money.

## Routers

A router is thin oRPC wiring: resolve the caller, call the service, map errors. No business
rules live here.

`createWalletRouter` in `packages/core/src/wallet/router/index.ts` is the model. It takes the
service, binds the contract with `implement(walletContract)` typed with `OssContext`, and each
handler reads the caller with `getUserId(context)` and delegates to the service (`getBalance`,
`deposit`). `mapErrors` from `@openora/core/server` maps service errors.

## Plugins

Typed plugin objects are the only way new functionality enters the system. In `register(ctx)` you bind
adapters, add routers, subscribe to events, and register agent tools and action types - the reads
a model may make and the changes it may only propose, served only through the MCP kernel.

`packages/core/src/wallet/plugin.ts` is the model. The plugin has an `id` and an optional `dependsOn`
list of load-order hints. In `register` it provides `PAYMENT_ADAPTER` with `MockPaymentAdapter`, and
adds the `wallet` router through `ctx.routers.add`, whose factory resolves `DRIZZLE`, `EVENT_BUS` and
`PAYMENT_ADAPTER` from the container, builds `WalletService`, and hands it to `createWalletRouter`.
The export is typed `satisfies Plugin<CoreTokenCatalog>`.

## Ports & adapters

Third-party integrations (payments, KYC, messaging, realtime, jobs) are ports - an interface
plus a typed token. A module depends on the port; you bind any vendor in a plugin. Swap a vendor
by binding a different implementation in a later-loading overlay - no module change.

The wallet plugin binds the default this way: `ctx.provide` with `PAYMENT_ADAPTER` and a
`MockPaymentAdapter` factory (`packages/core/src/wallet/plugin.ts`). An overlay calls `ctx.provide`
with the same token and a real vendor adapter built from its own env config, and the later binding
wins.

## Events

Modules stay decoupled by reacting to domain events, never importing each other's internals.
Declare the payload in the Zod catalog and subscribe in a plugin. Informational events emit
after commit via `emit`; money, compliance and RG events are written in the transaction via
`emitInTransaction`, and the outbox relay publishes them once it commits (ADR-0045).

A money event is emitted from a service inside its transaction with `emitInTransaction`, passing the
transaction handle, the topic and the payload - `wallet.deposit.completed` in
`packages/core/src/wallet/service/wallet.service.ts` is the model. An informational event such as
`promo.rank.changed` is emitted with `emit` after commit. A plugin subscribes with `ctx.events.on`
and the topic, receiving the payload - for example to credit a first-deposit bonus on
`wallet.deposit.completed`.

The same bus is a facade over a swappable message broker - in-process by default, a durable
broker (RabbitMQ/Kafka) via an overlay, with no module changes.

## Next

- [Architecture](./architecture.md) - how these fit together.
- API reference - every route, generated from the live contract, served at `/docs` by a running API (see the [Quickstart](../guides/quickstart.md)).
