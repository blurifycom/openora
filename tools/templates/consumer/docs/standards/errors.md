# Errors

Read this before adding an error class, a catch, or a money-handling path.

- Fail fast at boundaries with typed errors (`CreateOrderSchema.parse(raw)` throws early).
- No silent catches - log with context and rethrow.
- Typed, named error classes via the shared factories (`makeNotFoundError`/`makeOwnershipError`/
  `makeConflictError`); the router's `mapErrors` keys off the exported class.
- `ORPCError.message` is an English fallback for logs, not player-facing copy - UI copy keys off
  `.code` plus typed `.data` fields.
- Money/critical paths are transactional AND idempotent: a DB guard inside the transaction, not
  just an `idempotencyKey` (delivery is at-least-once).

```ts
// bad - swallows the error, no context, no rethrow
try {
  await chargeWallet(tx, amount);
} catch {
  return null;
}
// good - a DB guard makes the mutation idempotent under at-least-once delivery
await db.transaction(async (t) => {
  if (await ledgerExists(t, idempotencyKey)) return;
  await insertLedger(t, { idempotencyKey, amount });
});
```
