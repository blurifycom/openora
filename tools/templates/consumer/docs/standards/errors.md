# Errors

Read this before adding an error class, a catch, or a money-handling path.

- Fail fast at boundaries with typed errors (`CreateOrderSchema.parse(raw)` throws early).
- No silent catches - log with context and rethrow; a catch that returns null swallows the error.
- Typed, named error classes via the shared factories (`makeNotFoundError`/`makeOwnershipError`/
  `makeConflictError`); the router's `mapErrors` keys off the exported class.
- An overlay route that answers a vendor's own protocol, such as an inbound callback, throws
  `wireErrorResponse(status, body, { cause })` from `@openora/core/server`: the reply carries that
  status (400-599) and JSON body, not oRPC's error envelope. A 5xx reply is reported through its
  `cause`; pass the error that caused it, or log it yourself.
- `ORPCError.message` is an English fallback for logs, not player-facing copy - UI copy keys off
  `.code` plus typed `.data` fields.
- Money/critical paths are transactional AND idempotent: a DB guard inside the transaction, not
  just an `idempotencyKey` (delivery is at-least-once). Inside the transaction, look for an
  existing ledger row for the key and return early before inserting a new one.
