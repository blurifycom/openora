# Consuming the platform from a downstream repo

How a downstream operator builds their own igaming on top of `@openora/*` without
forking core. The root `AGENTS.md` links here; this is the detail an agent loads only when
actually wiring a consumer.

See the generated `docs/catalog.json` (`pnpm gen:catalog`, also served by `@openora/mcp`) for the machine-readable surface (routes, schemas, adapter
tokens, events, config schema, agent tools and action types) an agent reads instead of grepping `node_modules`.

## Fastest path: scaffold the repo

From this OSS checkout, generate a full consumer turborepo that installs `@openora/*` from npm:

1. `pnpm create:app ../my-igaming --name my-igaming` scaffolds the repo next to this checkout.
2. In the new repo, run `pnpm install`.
3. Run `pnpm bootstrap`: it writes `.env`, starts Postgres and Redis in Docker, applies the schema, and seeds an admin and demo data.
4. Run `pnpm dev` to serve the api on port 3001.

The platform is **headless backend only** - it ships modules, contracts, and SDK consumption surface only. Build your entire frontend (player web, admin backoffice, components, styling, theme) in your own repo and consume the api over HTTP via `@openora/core/react`.

After install, approve the `oss` MCP server from `.mcp.json` and run `/start` in Claude Code: it asks what you want to
build, calls the `enhance-intent` MCP tool to turn the ask into a grounded spec, and drives the
matching scaffold flow. See [mcp-setup.md](./mcp-setup.md).

This emits a headless api consumer: `apps/api` (thin `createApp` entry +
`extensions.config.ts`), `@openora/*` installed from npm, `.mcp.json`, the three
consumer AI agents, and `turbo/generators/` (`pnpm gen plugin|adapter`). `pnpm create:app` runs the
`@openora/create` scaffolder (`packages/create-openora`, the same one `npm create @openora`
runs); the base tree is `tools/templates/consumer/`. Read on to
understand what it generated and how to extend it.

### Frontend

Your entire frontend lives in your own repo (the platform is headless backend only). It consumes the api over HTTP through `@openora/core/react` (data hooks, auth, transport, cross-cutting helpers). A consumer fetches data through these hooks and manages its own SSR/hydration. React/react-dom/@tanstack/react-query are deduped via the consumer's bundler alias so the linked `@openora/*` and the app share a single physical React copy.

## API entrypoint

A downstream consumer imports `@openora/core/server` + `@openora/core/contracts` and creates an API
instance. `createApp` is domain-agnostic - the consumer composes its own contract and injects
its PAM identity tables (ADR-0025/0026: single-tenant). The scaffolded entry is `tools/templates/consumer/apps/api/src/main.ts.tpl`. It calls `createApp` with:

- `plugins`: the consumer's own plugin list from `extensions.config.ts`.
- `contract`: built with `composeContract` from `@openora/core/contracts`, passing only the module contracts you enable (for example the identity contract from `@openora/core/pam/contracts/identity` and `walletContract` from `@openora/core/wallet/contract`); `composeContract` adds `health` itself.
- `authSchema`: the PAM identity tables `user`, `session`, `account`, `verification` and `twoFactor` from `@openora/core/pam/schema/identity`.
- `port` and `cors.origins`.

Then it awaits the `listen` function `createApp` returns.

`createApp` serves a live API reference at `/docs` and its matching OpenAPI document at `/openapi.json`.

`createApp` refuses to boot without CORS origins: it takes `cors.origins`, else the comma-separated `CORS_ORIGINS` env var. Pass `cors: false` for an API served same-origin only. Request bodies are capped at 4 MiB (413 above it); raise or lower the cap with `bodyLimit: { maxBytes }`, or turn it off with `bodyLimit: false` when a proxy in front already enforces one.

`createApp` sends anonymous usage telemetry unless `telemetry: false` is passed or `OPENORA_TELEMETRY_DISABLED=1` is set. [Usage telemetry](../platform/telemetry.md) lists what a report carries.

Downstream consumers create their own thin entrypoint that calls `createApp` and bring
their own `extensions.config.ts`. See `tools/templates/consumer/apps/api/src/main.ts.tpl` for the reference.

### Running more than one process

Chat runs as its own service by default: the `compose.prod.yml` a new consumer gets starts the API and
a `chat` service from one image on one shared database, with a gateway sending the chat paths to it
(see the [split deployment guide](./split-deployment.md)). A single process that loads every module
stays supported for local dev, tests and small installs; it is what you get with no `SERVICE_MANIFEST`.

Replicas of one API share a `SERVICE_NAME` (unset means `monolith`) and split the work: each event
and each job reaches one of them.

- **Fewer modules in a process.** `SERVICE_MANIFEST` lists the module ids a process boots, and
  `createApp` applies it to the `plugins` you pass. List every module your modules depend on and
  every module that binds a port they require. A module still boots without an optional port, so
  the boot log also lists each one the manifest leaves unbound and what its module skips without
  it. A control - an RG limit, a country check, an audit record, the database grants and 2FA
  checks behind admin routes - is different: while your plugin list has the module that enforces
  it, a manifest that leaves it out refuses to boot. Whatever is missing, the boot fails once,
  naming all of it, with one manifest line that adds every module needed and what those need in
  turn. A process with a manifest needs a `SERVICE_NAME` of its own. Its consumer groups are new
  and start at the stream tail; set `EVENT_BUS_START_ID=0` for its first boot to replay retained
  events instead (every handler in it must be safe to run twice), then drop it.

  With the shipped modules a split ends up close to the monolith. Every manifest boot checks
  AdminGuard's ports, so every split loads iam and identity, and with them audit and mail.
  Identity's controls pull in compliance, and compliance depends on wallet, gaming,
  player-management and exchange-rate; player-management requires the `CHAT_BLOCK_READER` port, which
  the `chat` module binds, or `chat-remote` when chat runs in another service (`CHAT_SERVICE_URL`). A split is those nine
  modules, `chat` or `chat-remote`, and the ones you meant to move. Name the nine `:no-routes`:
  the split then only binds their ports, and leaves their events, jobs and schedules to the
  process that selects them ([ADR-0050](../adr/0050-dependency-only-modules-provide-but-do-not-consume.md)),
  so nothing is handled twice.

- **Chat writes from a process that does not run chat.** A module that writes chat state inside
  its own transaction binds the outbox writers from `@openora/core/engagement/server` over the
  chat module's local ones: `OutboxChatSystemWriter` for `CHAT_SYSTEM_WRITER` and
  `OutboxChatContextRoomCommands` for `CHAT_CONTEXT_ROOM_COMMANDS`. Each write becomes an event in
  the caller's transaction, so it commits or rolls back with the caller's own rows, and the chat
  service applies it after the relay delivers it. Nothing is read back: the caller names the
  context room (`roomId`) and each system message (`messageId`) with its own ids, and knows the
  members from its own records. Chat applies every command idempotently, but not in the order
  they were issued: the relay orders by `occurredAt` alone and replicas consume concurrently. A
  system message is stamped with the time it was issued, so the room still shows the caller's
  order. A command for a ref chat has no room for yet fails and is redelivered until the ensure
  lands; with two or more replicas the first message can arrive a minute or more late. A command
  chat can never apply (a `roomId` other than the ref's room, a `messageId` that names another
  message, a deleted room) fails the same way and ends in
  `oss:dlq:chat.context_room.command_issued`. Members only join, through `ensureRoom`, and
  ensuring a closed room adds nobody: removing a member is not offered in this mode, since a
  removal could land before the add it should follow. Use `CHAT_CONTEXT_ROOMS` only where chat
  shares the process: it also reads rooms back and removes members.

- **Fewer queues in a process.** `JOB_WORKERS` picks the job queues a process consumes: names,
  `prefix*` patterns, `!` to exclude. To keep a long-running queue off the API replicas, run one
  more instance with the same plugins and `SERVICE_NAME` and `JOB_WORKERS=<queues>`, and give the
  replicas `JOB_WORKERS=!<queues>`. Every queue needs a consumer somewhere. See
  [ADR-0049](../adr/0049-per-process-job-worker-selection.md).

- **Calls between services.** Set `INTERNAL_API_SECRETS` to the same comma list on every
  process, with each secret at least 32 characters. A plugin serves a call with
  `ctx.routers.addInternal(namespace, factory)`, which mounts under `/internal/v1`, and
  another process calls it with
  `createInternalClient({ baseUrl, serviceName, audience, secrets, timeoutMs })`, where
  `audience` is the called service's `SERVICE_NAME` and `secrets` is the
  `INTERNAL_API_SECRETS` value. Inputs go in the signed JSON body; a handler that moves money
  takes an idempotency key there. A handler that serves only some callers checks
  `context.internalCaller` against an allow-list. A signed call never carries a session. While
  the variable is unset every internal route answers 401. Your internet-facing edge (load
  balancer or reverse proxy) MUST deny `/internal/`; services call each other directly over the
  private network. For rotation and limits, see
  [ADR-0054](../adr/0054-signed-internal-api-for-service-calls.md).

- **Chat on a database of its own.** On the chat service set `IDENTITY_SERVICE_URL` to the
  identity service's private origin and `IDENTITY_SERVICE_NAME` to its `SERVICE_NAME`, and name
  `identity:no-routes` in its `SERVICE_MANIFEST`; on the identity service set
  `ACCOUNT_READER_CALLERS`, `SESSION_RESOLVER_CALLERS` and `ADMIN_PERMISSION_CALLERS` to the
  chat service's `SERVICE_NAME` (unset refuses every caller; without the last, every admin
  check on chat is refused). Chat reads admin grants from the iam owner through the same
  `IDENTITY_SERVICE_URL`, so the service that serves identity must serve iam too. Those lists guard against misconfiguration only: one install-wide secret signs as any caller.
  In production the URL must be https, or the boot fails; set `IDENTITY_SERVICE_ALLOW_HTTP=true`
  only where a service mesh encrypts the hop inside the private network.
- Only the chat plugin binds the remote reader. Run social in the same process as chat, or
  keep social on the identity database.
- Chat keeps each account it reads for 30 seconds in a cache of 10,000 accounts. Admin
  checks, room invites, a roster viewer's staff check and social's privacy gates always read
  fresh. Past 10,000 accounts online, rosters and online counts read cold on every call.
- While identity is down, chat answers 503, history shows no avatars and a new message is
  stored under the name `Unknown player`, never a name the client sent. A 4xx from identity (a caller missing from
  `ACCOUNT_READER_CALLERS`, or clock skew past the signature window) shows as 500 on every
  chat route: check both first.
- Setting `IDENTITY_SERVICE_URL` on a process that serves identity itself fails the boot.
- Chat resolves every request's session through the identity service, which runs the same
  chain as a local request: the session, the idle window, the second-factor enrolment flag and
  the player's last-seen stamp. Only the session cookie and `Authorization` header travel to identity
  in the signed body (the rest of a cookie jar stays in chat), so the https rule above also protects
  them; a request with neither is unauthenticated without a call. Chat keeps a session identity
  confirmed for 5 seconds, in a cache of 10,000 sessions keyed by a hash of the credential; a
  refusal (unknown, expired or idle session) is never cached.
- A revocation reaches chat as an event (`identity.session.revoked`, `identity.sessions.revoked_all`,
  `identity.user.deactivated`: an admin's revoke, a password change or reset, a deactivation,
  an idle timeout), and every chat replica then drops that user's cached sessions. The player's
  own sign-out emits no event, so a signed-out session still works on chat for up to the 5
  seconds. So does a change to the second-factor enrolment requirement, and the idle clock chat
  reads is as old as the cache.
- Admin security (second-factor enrolment, device binding, IP policy) on chat's admin routes is
  decided by identity on every call and never cached, so it follows identity's configuration, not
  chat's. While identity is down those routes answer 503.
- While identity is down (a timeout, a network failure or a 5xx), protected chat routes answer
  503, public routes still serve, and a signed-in player is not kept on a stale answer. Chat logs
  the first failure, then one summary line per 30 seconds with the count. A 4xx from identity
  answers 401, so a caller missing from `SESSION_RESOLVER_CALLERS` shows as 401 on every
  protected chat route: check that list first.
- **Chat's block reads and transfer check from a process that does not run chat.** Set
  `CHAT_SERVICE_URL` to the chat service's private origin there: `createApp` drops `chat` and the
  plugins that depend on it, and `chat-remote` (in `corePlugins()`) takes their place; a registry not built from `corePlugins()` must list `chat-remote` itself. Set `CHAT_SERVICE_NAME` too if the chat
  service's `SERVICE_NAME` is not `chat`. It binds
  `CHAT_BLOCK_READER` and `CHAT_TRANSFER_CHECK` to the chat service's internal API, so the process
  needs no chat tables. On the chat service set `CHAT_BLOCK_READER_CALLERS` and
  `CHAT_TRANSFER_CHECK_CALLERS` to the caller's `SERVICE_NAME`; unset, every caller is refused. The
  chat plugin refuses to boot while `CHAT_SERVICE_URL` is set. Nothing is cached, and a read or
  check chat cannot answer fails closed: a block read answers 503, a transfer check refuses with
  `chat_unavailable`. The remote check holds no block lock, so a block committed between its answer
  and the caller's commit is not seen. In production the URL must be https unless
  `CHAT_SERVICE_ALLOW_HTTP=true`. See the [split deployment guide](./split-deployment.md).

## Seeding reference data (production)

Migrations carry **structure only** (DDL: tables, indexes, constraints) - never data.
Reference data a module needs to function (e.g. IAM's predefined backoffice roles) is seeded
separately by **module seeders** - a function each module exports from its `/seed` subpath
(e.g. `seedRoles` from `@openora/core/iam/seed`). They are **convergent upserts**
(`ON CONFLICT ... DO UPDATE`), so editing the declared data and re-running reconciles existing
rows - safe to run on every deploy.

Seeding is a **standalone one-shot script**, exactly like migrations (the `openora-migrate` bin shipped
by `@openora/core` imports every `migrate()` callable and runs them). It needs only a DB connection - it never boots the
app (no HTTP, no auth, no plugin host), so it is cheap and carries zero footprint in the running
server. You compose the seeders you want explicitly, then run it after migrations. The script, for example `apps/api/src/seed-reference.ts` in the consumer, opens a connection with `createDrizzleDb` (from `@openora/core/server`) on `DATABASE_URL`, then awaits `seedRoles` (from `@openora/core/iam/seed`) and one call per additional module seeder you enable. Run it after `db:migrate`, before or at release.

Wire it as its own command (e.g. a `db:seed:reference` package script that runs `src/seed-reference.ts` with tsx) and run it in your release
pipeline right after `pnpm db:migrate`. Because the seeders are idempotent upserts, re-running on
each deploy is the intended pattern. Composition is explicit (like `extensions.config.ts`): enable
a module's seeder by adding its one import + call - the same trade-off the migration runner makes.

### Running a single module's seeder

Each seeder is a plain `(db) => Promise<void>` function with no runtime coupling, so you can run
any one in isolation, in any order - you are never forced to seed everything at once. Drive this
however suits your pipeline. For example, open the connection with `createDrizzleDb` and await only `seedRoles` from `@openora/core/iam/seed` to seed just the IAM roles.

Common orchestration patterns:

- **One script per module** - `db:seed:iam`, `db:seed:casino`, ... each importing a single seeder.
- **One script with a flag** - `pnpm db:seed --only=iam` branches on the arg.
- **One combined script** - imports and runs them all, like the reference script above.

**Local data** is a separate, dev-only concern. The scaffolded `apps/api/src/seed.ts` calls
`seedLocalData` from `@openora/core/seed/local`: reference data, a super-admin from `ADMIN_EMAIL` /
`ADMIN_PASSWORD`, and demo players, games, wallets and chat. It wipes demo tables, so it refuses
`NODE_ENV=production` and any database host other than localhost. Never run `db:seed` in a release
pipeline; production runs a reference-data script like the one above.

## Building the frontend (in your own repo)

Your entire frontend repo is built from scratch - pages, components, admin shell, theme, styling. It consumes the api over HTTP through `@openora/core/react` (typed client, data hooks, auth, realtime transport).

Wrap your root layout with `QueryClientProvider` and `ApiClientProvider` (from `@openora/core/react`). In a client component such as `app/providers.tsx`, import your own global stylesheet and render `ApiClientProvider` (`packages/core/src/react/context/api-client.tsx`) around `children`, passing the api `baseUrl` as its `client` prop.

### Styling and components

The platform ships no UI - your frontend owns all components, styling, and theme. Pick whatever
you like (Tailwind + DaisyUI, MUI, your own design system); OSS only feeds you data via the
hooks. If you use Tailwind v4 + DaisyUI, enable it in your own CSS build with a
`postcss.config.mjs` that lists the `@tailwindcss/postcss` plugin - or the `@tailwindcss/vite`
plugin for a Vite/TanStack app - and a global stylesheet. In it, import `tailwindcss` in the global stylesheet and enable the `daisyui` plugin with Tailwind's `@plugin` directive.

Cross-workspace `link:` requires a dedup alias in your frontend bundler config for `react`,
`react-dom`, and `@tanstack/react-query` (single physical path). See ADR-0005.

For the same reason, a linked consumer's own Drizzle code (tables + operators) must import from
`@openora/core/server/orm`, NOT from `drizzle-orm` directly. A direct `drizzle-orm` import resolves to the
consumer's own physical copy; drizzle's protected-member classes then fail nominal type checks
against `DrizzleService.db` (which uses `@openora/core/server`'s copy). `@openora/core/server/orm` re-exports the
framework-free drizzle surface from the single shared instance.

Full hooks guide: `docs/standards/react-sdk.md`.

## Local dev linking to a sibling consumer

Until OSS packages are published to npm, downstream consumers point at this workspace via
`pnpm.overrides` + `link:`. From the consumer's `package.json`:

In the consumer's `package.json`, set a `pnpm.overrides` entry that maps `@openora/core` to `link:../openora/packages/core`. Everything is folded into one package (ADR-0025): linking `@openora/core` gives every domain as a subpath.

Each linked package's `main` resolves to `./dist/index.js`, so the consumer reads BUILT output.
To keep the link hot during dev, run a watch build here in parallel with the consumer's dev
process with `pnpm -F @openora/core build --watch`.

Modules under `packages/core/src/<domain>/*` are loaded by the consumer via `extensions.config.ts`
paths pointing at built plugin files - see the load pattern below.

Rejected alternatives: `pnpm link --global` (legacy, leaks state), `yalc` (extra publish step
on every change), `file:` (snapshot copy on install, no live source).

## Consumer load pattern

Consumer `extensions.config.ts` loads core's modules through `corePlugins()`, which resolves the
built plugin files inside `@openora/core`, not source, because tsx in the consumer's API entry
can't reliably resolve the tsconfig. Always build `@openora/core` before booting the consumer with `pnpm -F @openora/core build`. For a watch loop during development, run `pnpm -F @openora/core --parallel build --watch`.

Every path in the consumer's `extensions.config.ts` must be absolute. The plugin host imports each
entry from inside `@openora/core`, so a relative path or a bare package name resolves from core's
location, not from the config file. A bare package name works only when core itself can resolve
that package. An add-on package installed in the consumer (a premium or third-party module
published on its own scope) therefore fails with a module-not-found error at boot. Resolve such a
package in the consumer and pass the resulting absolute path. The consumer template's
`extensions.config.ts` shows both cases: a local overlay and an add-on package.

## Keeping the agent files in sync

The scaffold's `.rulesync/` (skills, subagents, commands, hooks, shared rules) and `docs/standards/` are rendered from `@openora/create`'s consumer template, and the scaffold keeps that link alive:

- `tools/sync-agents.mjs` runs on `pnpm install` (via `prepare`) and renders every template-owned file at the pinned `@openora/create` version. It also rewrites a managed `synced-agents` block in `.gitignore` listing exactly what it wrote, so those files are generated artifacts: never committed, never in a diff, unable to drift.
- `.rulesync/sync.json` holds the operator's variables (`name`, `scope`, tracker key, wiki space, team channel, git remote path) and a `consumerOwned` list - template files the operator keeps its own tracked version of (`overview`, `mcp.json`, `sync.json` by default).
- The consumer tracks only what it owns: the rules and skills the template does not ship, plus those overrides. Operator-specific facts belong there or in `sync.json` vars, never in a generated file.
- An improvement to a generated file is made upstream in `tools/templates/consumer/`, lands with the next canary, and reaches the consumer on its next `@openora/*` bump and install.
- Under `pnpm link:oss` the script reads the checkout's `tools/templates/consumer` directly, so a template edit can be tried in the consumer before it is published.

## Paired changes across both repos

When a consumer change needs a core change, agents in the consumer repo make both, from any agent tool:

- `pnpm oss:worktree <branch>` in the consumer creates a git worktree of this repo under `.worktrees/` (gitignored here). The consumer's `guard-core` hook allows writes there and nowhere else in the checkout.
- Both repos use the same branch name, which is what pairs them. Neither request links to the other.
- The consumer's `review` skill reviews the diff here by this repo's own rules and cross-checks the contract between the two.

The consumer's `docs/agents/cross-repo.md` has the full conventions and how each agent tool is granted access to the checkout.

## Tooling notes

- Drizzle tables live in each module's `src/schema/index.ts`. `drizzle.config.ts` (in `@openora/core/server`)
  globs those files; `pnpm regen` runs drizzle-kit to generate migrations. There is no
  schema-merge step.
- All 15 core modules compile together as part of `@openora/core` (`tsc`, rootDir
  `packages/core/src`, emitting `dist/<domain>/<module>/src/...`).
- `pnpm-workspace.yaml#allowBuilds` (pnpm 11 syntax) replaces the legacy
  `pnpm.onlyBuiltDependencies` in package.json.
- A consumer gets the same AI surface this repo has by running the published `@openora/mcp` server
  against their own repo (see its README) and reading the generated `catalog.json`.
