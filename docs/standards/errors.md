# Error handling

Detail for the "typed errors at the edge" line in `conventions`. Read this when adding an error class, a catch, or a money path.

- **Fail fast at boundaries with typed errors** - `Schema.parse(raw)` throws early.
- **No silent catches** - log with context and rethrow, or handle explicitly.

  ```ts
  // bad - swallows the cause, the caller sees a lie
  try {
    await psp.capture(id);
  } catch {
    return { ok: false };
  }
  // good - context in, error out
  try {
    await psp.capture(id);
  } catch (err) {
    this.logger.error({ err, withdrawalId: id }, 'psp capture failed');
    throw err;
  }
  ```

- **Typed, named error classes mapped to transport at the edge.** Use the shared factories (`makeNotFoundError`/`makeOwnershipError`/`makeConflictError`); the router's `mapErrors` keys off the exported class. `export const WalletNotFoundError = makeNotFoundError('Wallet');`
- **Error factories keep the SAME exported const identifier** (`export const WalletNotFoundError = makeNotFoundError('Wallet')`) - routers import the class and `mapErrors` keys off it.

  ```ts
  // bad - the router hand-rolls transport mapping and leaks a raw message
  catch (err) {
    throw new ORPCError('CONFLICT', { message: (err as Error).message });
  }
  // good - the service throws its typed class, the router maps it
  mapErrors({ CONFLICT: IdempotencyKeyReuseError }, () => wallet.deposit(input));
  ```

  Canonical router to copy: `packages/core/src/wallet/router/index.ts`.

- **`ORPCError.message` is an English fallback for logs/tooling, not player-facing copy** - never render it directly in a UI. Consumers key UI copy off `.code` (the error category) plus typed `.data` fields (e.g. a `reason` discriminator); add a new field to `data`, not to `message`, when a UI needs to tell cases apart.
- **Money / critical paths are transactional and idempotent** - a DB guard inside the transaction, not just an `idempotencyKey` (delivery is at-least-once):

  ```ts
  await db.transaction(async (t) => {
    if (await ledgerExists(t, idempotencyKey)) return;
    await insertLedger(t, { idempotencyKey, amount });
  });
  ```
