# Error handling

Detail for the "typed errors at the edge" line in `conventions`. Read this when adding an error class, a catch, or a money path.

- **Fail fast at boundaries with typed errors** - `Schema.parse(raw)` throws early.
- **No silent catches** - log with context and rethrow, or handle explicitly. A bare catch that returns a failure flag swallows the cause and the caller sees a lie: log the error with the entity id as context and rethrow it.

- **Typed, named error classes mapped to transport at the edge.** Use the shared factories (`makeNotFoundError`/`makeOwnershipError`/`makeConflictError`); the router's `mapErrors` keys off the exported class. `WalletNotFoundError` in `packages/core/src/wallet/service/wallet.service.ts` is the pattern.
- **Error factories keep the SAME exported const identifier** (`WalletNotFoundError` above) - routers import the class and `mapErrors` keys off it. A router never hand-rolls transport mapping or forwards a raw error message in an `ORPCError`: the service throws its typed class and the router maps it with `mapErrors`.
  Canonical router to copy: `packages/core/src/wallet/router/index.ts`.

- **`ORPCError.message` is an English fallback for logs/tooling, not player-facing copy** - never render it directly in a UI. Consumers key UI copy off `.code` (the error category) plus typed `.data` fields (e.g. a `reason` discriminator); add a new field to `data`, not to `message`, when a UI needs to tell cases apart. The one exception is a message the operator configures for players, such as `promo.bonus.lockedFundsMessage` (ADR-0064) or `wallet.turnover.lockedMessage` (ADR-0065).
- **A route that speaks a vendor's protocol answers in that protocol.** An overlay route for an inbound vendor callback throws `wireErrorResponse(status, body, { cause })` from `@openora/core/server`: the response carries that status (400-599) and the body (a JSON object or array, sent as JSON), not oRPC's `{ defined, code, status, message, data }` envelope. A 5xx reply is reported through its `cause`; pass the error that caused it, or log it yourself. Every other route keeps throwing `ORPCError` through `mapErrors`.
- **Money / critical paths are transactional and idempotent** - a DB guard inside the transaction, not just an `idempotencyKey` (delivery is at-least-once): put a unique index on the namespaced key and insert with `onConflictDoNothing`; an empty result means another request won, so re-read its row and return it as a replay. A check before the insert races: two deliveries of the same key both pass it. See `insertIdempotentTransaction` in `packages/core/src/wallet/service/wallet.service.ts`.
