# Types and data modeling

Detail for the "infer, never hand-write" line in `conventions`. Read this when adding a schema, a type, or an enum-like value set.

- **One source of truth per shape - infer, never hand-write.** `z.infer<typeof UserSchema>`, `typeof users.$inferSelect`, `Omit<User, 'id'>`.
- **Schema-first at every boundary** (HTTP, config, env, messages, events). Validate once at the edge, trust the type after. oRPC + Zod does this for routes; do the same for config/env/event payloads.
- **No `any`, anywhere - tests included.** `unknown` + narrowing, or the real type. Never hand-roll a duplicate of a type that's one import away (`$inferSelect`/`$inferInsert`, a shared `@openora/core/*` type) - it silently drifts from the source of truth.
- **Never re-infer an imported schema** - the type is exported once from the owning contract; consumers import it, never re-run `z.infer` (lint: `oss-module-shape/no-reinfer-imported-schema`).

  ```ts
  export type PlayerProfile = z.infer<typeof PlayerSchema>; // bad
  import type { Player } from '@openora/core/contracts'; // good
  ```

- **No type casts (`as`) to silence the compiler - fix the root cause.** (`as const` is fine.) `as unknown as X` turns type-checking off entirely. If a symbol needs a type, give it one at the source (`createToken<T>()`), don't cast at use sites. Exactly two sanctioned exceptions:
  1. **Test doubles** - route through the `mock` helper (`packages/core/src/testing/mock.ts`) so the cast lives in one audited place, never inline in a test.
  2. **Third-party type-inference boundaries** a library gives you no honest way to satisfy - one cast with a one-line `// Library boundary:` note.

  ```ts
  // bad
  const user = data as User;
  const directory = { lookupPlayers } as unknown as AdminUserDirectory;
  // good
  const user = UserSchema.parse(data);
  const TOKEN = createToken<Config>('CONFIG');
  const directory = mock<AdminUserDirectory>({ lookupPlayers }); // cast confined to the helper
  ```

- **Never `!` non-null assertions** - narrow or restructure instead (lint: `typescript/no-non-null-assertion`).

  ```ts
  return toDto(row!); // bad
  return toDto(findOneOrThrow(rows, new XNotFoundError(id))); // good
  ```

- **Under `noUncheckedIndexedAccess`: `.at()`, destructuring-with-defaults, or an explicit guard - never `arr[i]!`.** `const [first = ''] = parts;`
- **`type` over `interface`** (lint-enforced).
- **Type entity ids through their owning type**: `User['id']`, never a bare `string` - the id's representation lives in one place and every signature follows when it changes (lint: `oss-module-shape/no-bare-string-id-param`). Bad: `roleId: string`. Good: `roleId: AdminRole['id']`.
- **Derive related schemas, never re-type fields**: `UserSchema.partial().omit({ id: true })`.
- **Enum-like value sets are a values + schema + type triple, declared once on the contract surface**: `X_STATUSES = [...] as const` -> `XStatusSchema = z.enum(X_STATUSES)` -> inferred `XStatus`. Anything in a route contract is public API - consumers need the runtime values (dropdowns, badge maps), so types alone are not enough. Never TS `enum`; never a second hand-typed copy of the set (in a consumer either - import it). Inline `z.enum([...])` outside a contract dir is a lint error (`oss-module-shape/no-inline-z-enum-outside-contract`).
- **Reuse `UuidSchema`** (`@openora/core/contracts`) for uuid fields, never a raw `z.uuid()`/`z.string().uuid()` - one source of truth for the shape (lint: `oss-module-shape/no-raw-z-uuid`).
- **Make illegal states unrepresentable** - discriminated unions (`{ status: 'loading' } | { status: 'ok'; data } | { status: 'error'; error }`) over optional-flag soup (`{ loading: boolean; data?: T; error?: Error }`).
