# Functions and modules

Read this before writing or refactoring a function, service method, or module.

- Pure functions with dependencies passed in as arguments; side effects only at the edges
  (services, adapters, plugins, handlers) - never in helpers.
- Immutability: derive new objects (`{ ...user, roles: [...] }`), don't mutate.
- Construct objects by spread + override, never field-by-field hand-copy. Keep fields explicit
  only for order-sensitive serialization, when the target must not receive some source fields, or
  when null-vs-undefined matters at a boundary.
- A `class` is only a thin dependency-holding shell at a composition root; methods delegate to
  pure functions. No inheritance for reuse, no decorators - compose.
- Short, single-purpose functions - if you'd write `// step 2` inside one, extract it.
- Guard clauses first, main path last.
- More than 3 parameters -> a single named-object param.
- Don't annotate a return type TypeScript can infer. Annotate only when: inference can't
  (recursion), you deliberately widen/narrow, or it's the exported public API of a shared
  `packages/*` module - there the explicit type IS the contract. Argument types always stay
  explicit.
- Named exports only - no default exports (exceptions: `*.config.*` files, `plugin.ts` whose
  loader reads `mod.default`, and Next.js App Router files; lint-enforced).

```ts
// bad - the service reaches into a global/container to hide what it depends on
export class WalletService {
  constructor(private readonly container: Container) {}
  async deposit() {
    const psp = this.container.get(PAYMENT_ADAPTER);
  }
}
// good - deps are constructor params of their port type
export class WalletService {
  constructor(
    private readonly db: DrizzleService,
    private readonly payments: PaymentAdapter,
  ) {}
}
```
