# Running Openora as more than one service

A new consumer ships chat as its own service: `compose.prod.yml` in the consumer template runs the API and chat from one image, on one shared database, behind a gateway that routes the chat paths. The single process that loads every module stays supported for local dev, tests and small installs, and is what you run when you drop the chat service. Any other module can move out the same way, scaled and released on its own while the rest stays together. Chat is the worked example here because it is the usual first candidate: long-lived connections, bursty traffic, few synchronous callers.

Nothing below needs a fork. It is environment variables read by `createApp` (`packages/core/src/server/runtime/create-app.ts`) and a plugin list you already have (`extensions.config.ts`). Production wiring (Postgres, `REDIS_URL`) is covered in [downstream-consumer.md](./downstream-consumer.md); the channel rules are in ADR-0030 and `.rulesync/rules/messaging-and-microservices.md`.

## The three variables

- `SERVICE_MANIFEST`: comma-separated module ids this process boots. Unset means every module (local dev, tests, a single-process install), and nothing in this guide applies.
- `SERVICE_NAME`: the Redis Streams consumer group. Every service must have its own.
- `REALTIME_NAMESPACE`: the prefix of every realtime key. Every service that talks to the same clients must share it.

A process that sets `SERVICE_MANIFEST` must set the other two or the boot throws. Without a manifest, `SERVICE_NAME` defaults to `monolith` and `REALTIME_NAMESPACE` defaults to `SERVICE_NAME`.

## SERVICE_MANIFEST

`SERVICE_MANIFEST=chat,identity:no-routes,audit:no-routes` loads those three modules plus every `kind: 'infra'` overlay in the plugin list (`service-manifest.ts`, `applyServiceManifest`). Infra overlays always load, they cannot be flagged, and their own dependencies count.

The manifest must be closed: every module a listed module `dependsOn`, and every module that binds a port a listed module requires. Chat `dependsOn` `identity` and `audit`, and identity `dependsOn` audit, so those are the floor. A split also refuses to boot when it would skip a control the rest of the install enforces (a geo check, an RG limit, the admin guard's permission resolver), as long as the plugin list contains the module that binds it.

You do not have to work the closure out by hand. Boot once with the short manifest. The failure lists every missing module and why, and ends with an `Add them:` line to paste, a complete `SERVICE_MANIFEST` value that lists your modules followed by each missing one as `:no-routes`.

It keeps your flags and adds each missing module as `:no-routes`, so another process keeps consuming it. An unknown id, an unknown flag, or `:no-routes` on an infra overlay also fails the boot, with the known ids in the message.

### Loading a module for its ports only

`id:no-routes` loads a module this service only requires, for what it provides (ADR-0050). It binds the module's ports and discards its router, so it serves no HTTP route, and it consumes nothing: none of the module's event handlers, agent trigger listeners, job workers or schedules are wired. Use it for every dependency. In the chat service above, `identity:no-routes` gives chat its session resolver without serving sign-in, phone-login or 2FA, and without handling identity's events a second time. A module named without the flag is selected, and the service consumes for it. Infra overlays are always selected.

Every module must be selected in some process of the install, or its handlers, jobs and schedules run nowhere. A process with no manifest selects every module it loads, so the template's `api` covers everything chat loads `:no-routes`. After loading, the boot logs how many handlers and workers each required module left to another service (`notConsumed`).

The router factory still runs, because several modules build their service inside it. A factory receives `options.mounted`, `false` for a `:no-routes` module: it skips what guards its HTTP surface and upserts no schedule. Identity refuses to build its router when the geo check is unbound, unless it is loaded `:no-routes`, so a process that serves auth routes without the compliance module fails closed instead of skipping the country gate.

## SERVICE_NAME: the consumer group

The broker (`RedisStreamsBroker`) creates one consumer group per (topic, `SERVICE_NAME`). Replicas of one service share the group and compete, so each event reaches one replica. Two different services each get their own copy of every event. Two services on the same name split the stream and each sees half.

So: one distinct `SERVICE_NAME` per service, and the same value on all replicas of that service.

The name is a durable identity. Never rename one in production. Renaming strands the old group's delivered-but-unacked entries, and the new group is created at the stream tail, so anything published while the group did not exist is not delivered to it unless `EVENT_BUS_START_ID=0` is set on first start. That is also why `createApp` will not derive the name from `SERVICE_MANIFEST`: that list reorders and grows.

## REALTIME_NAMESPACE: the realtime prefix

Channels, signals, presence and session revocation are all prefixed with it. A player's socket is held by whichever process accepted the connection, so a message published by any service has to land on the same keys the others read. Give every service of one deployment the same value. Two deployments sharing one Redis must use different values.

Presence and revocation follow it too. With the namespaces split, a session revoked in the main API would not reach a socket held by the chat service.

Because it defaults to `SERVICE_NAME`, a monolith that never set either keeps its keys as they are. When you add a second service, pin the existing one explicitly: `SERVICE_NAME=monolith` (leave it, do not rename) and `REALTIME_NAMESPACE=monolith`.

## Once per deployment or once per service

A module's `ctx.events.on` handler runs once in each service that selects the module; a service that loads it `:no-routes` does not subscribe it. Handlers are at-least-once and deduplicated per consumer through `processed_events`.

A handler that keeps state of the process it runs in up to date cannot rely on that: it runs in one replica of one service. Republish onto `REALTIME_TRANSPORT`, which every replica of every service of the deployment receives, the way chat purges its session cache on the identity session events. No shipped module keeps such state in a dependency: grant and catalog caches live in the shared Redis cache, so one purge reaches every service.

Some work must happen once per deployment however many services select the plugin. The audit writer is the example (`packages/core/src/audit/plugin.ts`): it would write one row per service otherwise. It passes `{ consumerGroup: 'audit' }` as the third argument of `ctx.events.on`, and `createApp` scopes it to `<REALTIME_NAMESPACE>/audit`. Every service selecting the audit plugin competes in that one group, and two deployments sharing a Redis stay apart. Reach for the same option in your own plugin only when a duplicate would be wrong, not as a default.

## Database

The cheap default is one shared Postgres. Services load the modules they need against the same database, and nothing about reads changes. That is a good place to stop for a long time.

Giving a module its own schema or database changes what is allowed across the boundary:

- A read that used to join the module's tables, or run in the same transaction as a write, becomes either a synchronous command port call or a read model the other side builds from events.
- An event that reports a committed change on a money, compliance, KYC or account-status path uses `emitInTransaction`, which needs the outbox row in the same database as the state change. It cannot span two databases.
- Money and any answer needed now never travel over events.

Decide this per module, later. Splitting the process does not force it.

## Worked example: chat next to the main API

The consumer template's `compose.prod.yml` is this example on one server, with the shared database and a Caddy gateway for the path prefixes. The `api` service sets no manifest; the `chat` service sets `chat`, `chat-commands`, `social` and the modules they need as `:no-routes`. Both share `REALTIME_NAMESPACE=monolith` and `INTERNAL_API_SECRETS`. To run one process instead, remove `CHAT_SERVICE_URL` from `api` and drop `chat` and `gateway`.

Chat's HTTP routes sit under `/chat/*` (player, realtime streams included) and `/backoffice/chat/*` (staff), and its handlers and jobs (room purge, moderation expiry) run wherever the module is selected.

The main API can drop chat. Of the modules it keeps, only `player-management` needs a chat port (`CHAT_BLOCK_READER`, for player search), and it requires the port, not the `chat` module. Set `CHAT_SERVICE_URL` and `createApp` drops `chat` and every plugin that `dependsOn` it, directly or through another dropped one (`social`, `chat-commands`), before it applies any manifest. The `chat-remote` plugin, part of `corePlugins()` (a hand-written registry lists it itself), then binds `CHAT_BLOCK_READER` and `CHAT_TRANSFER_CHECK` to the chat service's internal API (ADR-0054, ADR-0060). A module of your own that needs chat's tables must `dependsOn` chat to be dropped with it:

- `SERVICE_NAME` and `REALTIME_NAMESPACE`: both `monolith`.
- `CHAT_SERVICE_URL`: the chat service's private origin.
- `CHAT_SERVICE_NAME`: the chat service's `SERVICE_NAME`; the default is `chat`.
- `INTERNAL_API_SECRETS`: the shared secret.

The main API then has no chat tables to migrate and serves no chat route. A manifest on the main API must not name a dropped module (that is an unknown id); it is not needed to leave chat out. It also fails in the other direction: the chat plugin refuses to boot while `CHAT_SERVICE_URL` is set, so one process never binds the ports twice. In production the URL must be https unless `CHAT_SERVICE_ALLOW_HTTP=true` (a mesh that encrypts the hop).

The chat service serves the two routes only to the callers it names, and refuses every caller while the lists are unset:

- `CHAT_BLOCK_READER_CALLERS` guards the block reads, which are `POST` calls to `/internal/v1/chat/blocks/excluded`, `/blocked` and `/blockers`.
- `CHAT_TRANSFER_CHECK_CALLERS` guards the transfer check, a `POST` to `/internal/v1/chat-commands/transfer-check`.

Set both to `monolith`, the main API's `SERVICE_NAME`.

Both lists are comma-separated `SERVICE_NAME`s. They guard against misconfiguration only, because one install-wide secret signs as any caller name. A module that moves money in chat needs `chat-commands` on the chat service, which serves the transfer check.

Failures close. Neither read is cached, and each call times out at 500ms. A block read that cannot be answered (timeout, network, 5xx) throws a 503 `SERVICE_UNAVAILABLE`, never an empty list. A transfer check that cannot be answered refuses the transfer as `chat_unavailable` through `checkChatTransfer`. The remote check also holds no block lock: the chat service answers on a transaction of its own, so a block committed after the answer and before the caller's money commits is not seen. The local binding closes that window with a shared lock held until the caller's transaction ends. Tip and transfer commands move money through `guardChatTransfer`, which checks again after the caller's debit and ledger rows and throws `ChatTransferRefusedError` inside the caller's transaction on a refusal or a counterpart blocked since the first check, so the money rolls back. It never closes fully without a lock shared across the two services.

Chat service, on a database of its own and reaching identity over its internal API:

- `SERVICE_NAME`: `chat`.
- `REALTIME_NAMESPACE`: `monolith`, the same as the main API.
- `SERVICE_MANIFEST`: `chat`, `chat-commands`, `social`, plus `identity`, `iam` and `audit` as `:no-routes`; then add what the boot asks for.
- `INTERNAL_API_SECRETS`: the shared secret.
- `IDENTITY_SERVICE_URL`: the origin of the service that serves identity and iam.
- `CHAT_BLOCK_READER_CALLERS` and `CHAT_TRANSFER_CHECK_CALLERS`: `monolith`.

On the service that serves identity and iam, name the chat service so it may read accounts, sessions (admin security included) and admin grants: `ACCOUNT_READER_CALLERS`, `SESSION_RESOLVER_CALLERS` and `ADMIN_PERMISSION_CALLERS` (`POST /internal/v1/iam/admin-permissions/{grants,super-admin}`) each list `chat`. Unset refuses every caller, and without `chat` in `ADMIN_PERMISSION_CALLERS` every admin check on the chat service is refused. Chat reads grants through `IDENTITY_SERVICE_URL`, the same origin as accounts and sessions, so one service must serve both identity and iam. Chat caches no grant of its own, so a revoked admin loses access as soon as the iam owner's cache purges, and an unreachable owner refuses the request with a 503 rather than reading as "no grants". The chat service's own database holds no role assignments, so `iam:no-routes` there binds only controls and the remote resolver wins.

`CHAT_CONTEXT_SEND_POLICY` and `CHAT_ROOM_ACCESS` overrides must load on the chat service: that is where the send and room checks run.

A play-refusal rule bound to `PLAY_ELIGIBILITY` reaches chat's invites through the account read. The database-backed port reads tables the chat database does not hold, so with `IDENTITY_SERVICE_URL` set chat does not consult it; the identity service does, when an account read sets `playEligibility`, which only the invite checks do (`excluded` is core's own `checkPlay`, plus the bound port when an overlay replaced it, resolved at call time, for player accounts core admits). Every other read, a search or a mention lookup included, never calls the overlay port, so a port that throws cannot fail them. An invite to a player the identity service reports as excluded is withheld, read fresh on every invite, and an unreachable identity service refuses the invite with a 503 before anything is written. Load the overlay that rebinds `PLAY_ELIGIBILITY` on the identity service, not on chat.

The chat service runs the audit module against its own database and ships its audit rows to the chain through the audit outbox (ADR-0055). Its database needs the audit migration (`audit_outbox` and `audit_outbox_rejected`, plus `audit_log` when no `AUDIT_DATABASE_URL` is set), and with a separate chain database every process loading audit, chat included, sets `AUDIT_DATABASE_URL` and `AUDIT_SHIPPER_DATABASE_URL`.

Both get the same `REDIS_URL` and `AUTH_SECRET`; the chat service's `DATABASE_URL` names its own database. Route at the load balancer by path prefix:

- `/chat/*`, `/backoffice/chat/*`, `/social/*`, `/chat-command/*` and `/backoffice/chat-command/*` go to the chat service.
- Everything else (`/*`) goes to the main API.

Route every prefix. Without the staff ones, the staff routes go to `/*` and 404 once the main API stops serving chat.

Any realtime endpoint your frontend uses for chat must be routed to the chat service too; check which module serves it.

A main API that does not load chat runs none of chat's handlers or jobs. The chat service runs them all.

## Worked example: money apart from the platform

The money modules (`wallet`, `bonus`, `gamification`, `gaming`, `betting`, `exchange-rate`) can run in a `money` service while a `platform` service runs the rest (ADR-0067). Set `MONEY_SERVICE_URL` on the platform and `createApp` drops the money modules and every plugin that `dependsOn` one, directly or through another dropped one, before it applies any manifest, as `CHAT_SERVICE_URL` does for chat. A platform module that should stay must require money ports, not `dependsOn` a money module. The `money-remote` plugin, part of `corePlugins()`, then binds these ports to the money service's internal API:

| Port                                             | Remote methods                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `WALLET_READER`                                  | every read                                                                          |
| `EXCHANGE_RATE_READER`                           | `getRate`, `convert`                                                                |
| `ADMIN_WALLET_REPORTING`, `ADMIN_GAME_REPORTING` | every report                                                                        |
| `PLAY_ELIGIBILITY_PROJECTION`                    | `write`, `reconcile`, `heartbeat`, bound with `remote: true`                        |
| `RG_LIMIT_LEDGER`                                | `write`, `reconcile`, `drifted`, `heartbeat`, `spendFor`, bound with `remote: true` |

`remote: true` makes the owners follow ADR-0066: a lift or a loosened limit reaches the ledger by its event, and a restriction still writes first and fails the change when the write fails. On the money service, a non-empty `MONEY_PORTS_CALLERS` arms the stale check: stakes, deposits and wagers refuse once the last heartbeat is older than `LEDGER_PROJECTION_STALE_MS`, or missing. A fresh split install therefore refuses until the platform's first beat, at most `LEDGER_PROJECTION_HEARTBEAT_MS`.

Ports that take the caller's transaction cannot cross the network: `WALLET_COMMANDS`, `WAGER_TRACKING`, `BONUS_LIFECYCLE`, `BONUS_WAGERING`, `BONUS_GRANTS`, `BONUS_GRANT_LEDGER`, `GAMING_COMMANDS`, `RG_LIMITS` and `LEDGER_PLAY_ELIGIBILITY`. With `MONEY_SERVICE_URL` set, a kept module whose `requiresPorts` names one fails the boot with the module and the port in the message.

Platform service:

- `SERVICE_NAME`: `platform`.
- `MONEY_SERVICE_URL`: the money service's private origin.
- `MONEY_SERVICE_NAME`: the money service's `SERVICE_NAME`; the default is `money`.
- `INTERNAL_API_SECRETS`: the shared secret.

Money service:

- `SERVICE_NAME`: `money`.
- `MONEY_PORTS_CALLERS`: `platform`; it guards `POST /internal/v1/money/ports/call`.
- `INTERNAL_API_SECRETS`: the shared secret.

`MONEY_PORTS_CALLERS` is a comma list of `SERVICE_NAME`s; unset refuses every caller. Every call goes through one route, naming the port and method; the money service answers from its own binding and refuses a port or method outside the table above. A required `tx` argument is never sent: the money service runs a write in a transaction of its own and a read on its own connection.

Failures close. Nothing is cached, and each call times out at 2s. A read that cannot be answered (timeout, network, 5xx) throws a 503 `SERVICE_UNAVAILABLE`, never a zero balance; a refused call (4xx) stays a 500. A write is retried once with the same body after a timeout, network failure or 5xx, then throws. Every remote write is idempotent at the money service (a projection write keeps the newer version, a reconcile applies only a newer one, a heartbeat), so a retry or a late first attempt never replaces newer state. A typed port refusal (`RgRateUnavailableError`) comes back as a 422 with its code, is rethrown as the same class and is never retried. In production the URL must be https unless `MONEY_SERVICE_ALLOW_HTTP=true`. Rollback is redeploying the platform with `MONEY_SERVICE_URL` unset.

## A module on a database of its own

Every step above works on one shared database. Giving the chat service a database of its own adds three jobs: migrate each database, ship audit from each, and make sure every queue still has a consumer.

### Migrate once per database

Migrations never run at service boot. Run them per database with admin credentials, before the service that uses it starts.

- Each module keeps its own migration set and tracking table, so a new database migrates from zero and no history is copied.
- A database gets the sets of the modules it hosts, plus the engine set (the event outbox and processed events), because every service's event bus writes there.
- A module loaded only for its ports keeps its tables where it is hosted. Chat loads identity, iam and audit this way, so the chat database gets none of their tables.
- Audit is the one exception. Every database that hosts a service writing audit rows also gets the audit migration, which adds the guards and grants on the audit outbox (the table itself is in the engine set) and the chain table only when no `AUDIT_DATABASE_URL` is set.

### Audit: one outbox per database, one chain

- Each service writes its own audit outbox in the transaction of the change. A shipper in the same process moves the rows into the one chain database named by `AUDIT_DATABASE_URL`, so the chain stays single however many databases write to it.
- `AUDIT_SHIPPER_DATABASE_URL` names the shipper login on the process's own database. Each database has its own shipper login, never the admin or app role and never another database's shipper. A process that sets `AUDIT_DATABASE_URL` without it refuses to boot.
- The shipper alone may delete shipped rows from its outbox. The audit migration, called once per database with `adminUrl`, `auditUrl` and `shipperUrl`, creates the chain database and the roles.
- It refuses a shipper URL that names another database than the one being migrated, a chain URL that names that same database, and a writer and shipper that are one role or that are the admin or app login of the database.
- It also refuses an existing role with a superuser, createdb, createrole, replication or bypass-RLS attribute, a role that belongs to another role, and a role with a member that inherits it or may switch to it.
- Roles get a connection limit of 20 each. Keep replicas times `AUDIT_DATABASE_POOL_MAX` (default 3) under it.
- On the first migrate of a database with a separate chain, `CONNECT` is revoked from `PUBLIC` there. Roles that own a table or hold a grant on one keep it by name. Any other login (monitoring, backup, an app role whose grants come later) needs its own `GRANT CONNECT`.

### Every queue needs a consumer

Job queues live in the shared Redis, but a job's handler writes the database of the service that loaded its module. A worker that takes a chat job on a process without chat tables fails it, and a queue nobody consumes backs up in silence.

`JOB_WORKERS` picks the queues a process consumes. Unset or blank means every queue.

- Entries are separated by commas or spaces: a queue name, or a `prefix*` pattern with `*` only at the end.
- `!` before an entry excludes it. `*` or `all` means every queue, and combines with exclusions only. `none` consumes nothing and stands alone.
- An included name or pattern that no registered queue matches fails the boot, so a typo cannot leave a worker idle. An exclusion that matches nothing is allowed.
- The boot logs which queues the process consumes and which it skips.

For chat: the chat service sets `JOB_WORKERS=chat-*`, and every other process that could load a chat queue sets `JOB_WORKERS=!chat-*` or leaves the chat modules out. There are six chat queues: moderation expiry, room purge scan, room purge, account closed, account reopened and invite expiry. Do not set `none` on the chat service, or all six are stranded. The account closed queue is the one that matters for compliance: it removes a closed or self-excluded player from chat.

The account closed and account reopened jobs read the account fresh from the identity service on every attempt. With the identity service unreachable they retry five times with exponential backoff, then log `chat account-closed handling exhausted retries` (or the `account-reopened` twin) at error level and give up. Alert on those two log lines, and on the depth of both queues.

## Rollout

1. Deploy the chat service with the new `SERVICE_NAME`, taking no traffic, and set `CHAT_BLOCK_READER_CALLERS` and `CHAT_TRANSFER_CHECK_CALLERS` to the main API's `SERVICE_NAME`.
2. Move the chat prefixes above to the chat service at the load balancer.
3. Deploy the main API with `CHAT_SERVICE_URL` set, which drops chat from it.

Until step 3 the main API still loads chat, so chat handlers run in both services, idempotently. Its consumer group does not move, so step 3 loses nothing. The chat service's group is new: it starts at the stream tail, so deploy it (step 1) before you depend on it, or set `EVENT_BUS_START_ID=0` on it so the new group starts at the oldest retained event instead and a one-step rollout (as in `compose.prod.yml`) misses nothing. Every handler in that process, infra overlays included, then replays up to seven days of retained events once, so each must be safe to run twice; the chat handlers are. The setting applies whenever the process first creates a group, which includes a topic a later release starts consuming, and an existing group keeps its cursor. It is a first-rollout switch: drop it once the chat service has booted. `createApp` refuses it on a process without `SERVICE_MANIFEST`, so the main API never replays.

Rollback is routing and that variable. Redeploy the main API with `CHAT_SERVICE_URL` unset, and point the prefixes back at it.

## Redis loss

Every service shares one Redis. It holds the event streams with each consumer group's position, and the BullMQ queues. Postgres holds the copy that survives: every event written with `emitInTransaction` stays in `event_outbox` for 7 days after the relay published it (`EVENT_RETENTION_MS`), and each consumer records what it applied in `processed_events`, kept a day longer.

When Redis is lost or restored from a snapshot:

1. Restore the latest snapshot, or start an empty Redis.
2. Start the services. A consumer group the restore lost is recreated at the stream tail on boot, so it sees only events published from then on. Recurring job schedules are upserted again at boot.
3. Once every service is up, replay what was published since the snapshot, with a margin, against each database that has an outbox. Run `npx openora-outbox-replay` with `DATABASE_URL` and `REDIS_URL` set in the environment and the `--since` flag set to an ISO timestamp from before the snapshot. Add `--dry-run` to count first.

   It republishes every published `event_outbox` row with `published_at` at or after `--since`, oldest first, and prints a count per topic. `--topic <topic>` limits it to one topic; `--dry-run` only counts. A consumer skips an event it already applied, so a generous `--since` and a second run are safe. A `--since` older than the 7-day retention is refused with a non-zero exit: part of that range is already pruned. Unpublished rows are left to the relay.

Not recoverable from Postgres:

- An event sent with plain `emit()`. It never had an outbox row. Those are informational, catalog and cache-invalidation events; anything reporting committed money, compliance or account state uses `emitInTransaction`.
- A queued or delayed BullMQ job. It exists only in Redis. A recurring schedule comes back at boot; a one-off job enqueued before the loss does not.
- Realtime pushes, presence and the shared cache. They rebuild as players reconnect and caches miss.

## Checklist

- Each service has a distinct, stable `SERVICE_NAME`.
- Every service of the deployment has the same `REALTIME_NAMESPACE`.
- Every process with a manifest sets all three variables.
- Each queue has a consumer; each route prefix has exactly one owner at the load balancer.
- Once-per-deployment work uses `{ consumerGroup }`.
- Every module is selected (named without `:no-routes`, or loaded by a process with no manifest) in at least one service.

- Each database is migrated, with the sets of the modules it hosts plus the engine set, before its service starts.
- Every chat queue has a consumer: the chat service on `chat-*`, every other process on `!chat-*` or without the chat modules.
- Each database has one audit shipper login of its own, never the app role, and `AUDIT_DATABASE_URL` is the same on every service.
- Alerts on the account closed and account reopened dead-letter logs.

## Operational log signals

Two warnings exist to be alarmed on. A log metric filter matches the message text exactly, so the strings are part of the contract. Neither carries an event payload or player data. Both fire per replica, so a deployment with several replicas can log each one.

| Message                   | Fields                          | Fires                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event outbox lagging`    | `pending`, `oldestPendingAgeMs` | The oldest unpublished `event_outbox` row (claimed or not) is older than 60 seconds. Logged by the relay at most once a minute per replica, after a drain. Age is read on the database clock from the row's `occurred_at`. |
| `stream consumer lagging` | `stream`, `group`, `pending`    | A consumer group has more than 100 delivered but unacknowledged entries on a stream. Logged at most once a minute per stream and group, from the reclaim step.                                                             |

The first means a relay is running but not publishing: broker down, or a row failing every attempt. It cannot fire when no relay runs at all, so cover that with a log-absence alarm or a periodic health check on `eventOutboxBacklog(db)`. The second means the handlers of that group are slow or failing.

Generic alarms to start from: page on one `event outbox lagging` line, since it already means a row is over a minute old. Alert on `stream consumer lagging` when it appears in 3 of 5 consecutive minutes.
