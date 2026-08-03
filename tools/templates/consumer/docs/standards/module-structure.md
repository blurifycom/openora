# Package and module structure

Read this before creating a package, an overlay add-on, or wiring a new module's internal layout.

- One package = one concern, named `@<scope>/<kebab>`, with an explicit `exports` map. The
  entrypoint IS the public API; everything else is internal and off-limits to consumers
  (`oss-boundaries`).
- Overlay/add-on packages mirror the platform module shape: `contract/`, `schema/`, `service/`,
  `router/`, `adapters/`, `__tests__/`, plus `plugin.ts` at the root as the single wiring point.

| Layer    | File                        | Holds                                                           | Must NOT hold                    |
| -------- | --------------------------- | --------------------------------------------------------------- | -------------------------------- |
| schema   | `schema/index.ts`           | Drizzle `pgTable`s; row types via `$inferSelect`/`$inferInsert` | logic                            |
| contract | `contract/index.ts`         | oRPC route contract + req/res Zod schemas                       | logic, transport wiring          |
| service  | `service/<name>.service.ts` | ALL business logic; emits events after DB commit                | HTTP/transport knowledge         |
| router   | `router/index.ts`           | thin oRPC wiring: resolve caller, call service, map errors      | business rules                   |
| plugin   | `plugin.ts`                 | DI wiring only: `ctx.provide(...)`, route registration          | logic                            |
| adapters | `adapters/<vendor>/`        | concrete impls of adapter ports                                 | being imported by another module |

- Each overlay owns its `drizzle.config.ts` and its own migration history - never share one
  migration folder across packages.
- Pin exact dependency versions in every package; a package never depends on an app.
- Add a dependency deliberately - std lib or a few lines often beat a tree.

```ts
// bad - a service reaches into the container and hides what it depends on
export class WalletService {
  constructor(private readonly container: Container) {}
}
// good - deps are constructor params of their port type; plugin.ts does the resolving
export class WalletService {
  constructor(
    private readonly db: DrizzleService,
    private readonly payments: PaymentAdapter,
  ) {}
}
```
