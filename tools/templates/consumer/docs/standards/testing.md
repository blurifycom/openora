# Testing

Read this before adding or restructuring a test.

- Co-locate as `src/__tests__/<name>.test.ts` (Vitest); service tests use a vi-mocked Drizzle.
- Test behavior, not implementation - tests must survive a safe refactor (assert outputs, not
  private caches).
- Cover new logic as part of the same change: unit tests for pure functions, authz negatives
  included.
- Deterministic and isolated: no shared mutable state, no real network, seedable data.

```ts
// bad - a mocked builder chain proves a call order, not a result
const db = { select: vi.fn().mockReturnValue({ from: vi.fn().mockResolvedValue([row]) }) };
expect(db.select).toHaveBeenCalled();
// good - assert the outcome
expect(await service.get(id)).toEqual(row);
```
