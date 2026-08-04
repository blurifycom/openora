# Types

Read this before adding or changing a schema, type, or enum-like value set.

- One source of truth per shape - infer, never hand-write a type that already exists:
  `z.infer<typeof UserSchema>`, `typeof users.$inferSelect`, `Omit<User, 'id'>`.
- Schema-first at every boundary (HTTP, config, env, messages, events): validate once at the edge,
  trust the type after. oRPC + Zod does this for routes; do the same elsewhere.
- Never re-infer a schema you imported - the owning contract exports the type once; import it.
- No `any` outside tests - `unknown` + narrowing.
- No `as` casts to silence the compiler - fix the root cause (`as const` is fine).
- Never `!` non-null assertions - narrow explicitly, or restructure so the value is provably
  present (carry it on the object instead of re-looking it up).
- Under `noUncheckedIndexedAccess`: `.at()`, destructure-with-default
  (`const [first = ''] = parts`), or an explicit guard - never `arr[i]!`.
- `type` over `interface` (lint-enforced).
- Type entity ids through their owning type (`playerId: Player['id']`), never a bare `string`.
- Derive related schemas with `.pick()/.omit()/.partial()/.extend()/.merge()` - never re-type
  fields.
- Enum-like value sets are a values + schema + type triple declared once on the contract surface:
  `X_STATUSES = [...] as const` -> `XStatusSchema = z.enum(X_STATUSES)` -> inferred `XStatus`.
  Never a TS `enum`, never a second hand-typed copy - import the one from `@openora/*`.
- Make illegal states unrepresentable - discriminated unions
  (`{ status: 'ok'; data } | { status: 'error'; error }`) over optional-flag soup.

```ts
// bad - hand-written duplicate of an inferrable type
type User = { id: string; email: string; roles: string[] };
// good - infer from the schema that already validates the shape
type User = z.infer<typeof UserSchema>;
```
