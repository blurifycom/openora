# Running Openora as more than one service

By default one process loads every module. Any module can instead run in its own deployment unit, scaled and released on its own, while the rest stays together. Chat is the worked example here because it is the usual first candidate: long-lived connections, bursty traffic, few synchronous callers.

Nothing below needs a fork. It is environment variables read by `createApp` (`packages/core/src/server/runtime/create-app.ts`) and a plugin list you already have (`extensions.config.ts`). Production wiring (Postgres, `REDIS_URL`) is covered in [downstream-consumer.md](./downstream-consumer.md); the channel rules are in ADR-0030 and `.rulesync/rules/messaging-and-microservices.md`.

## The three variables

- `SERVICE_MANIFEST`: comma-separated module ids this process boots. Unset means every module, and nothing in this guide applies.
- `SERVICE_NAME`: the Redis Streams consumer group. Every service must have its own.
- `REALTIME_NAMESPACE`: the prefix of every realtime key. Every service that talks to the same clients must share it.

A process that sets `SERVICE_MANIFEST` must set the other two or the boot throws. Without a manifest, `SERVICE_NAME` defaults to `monolith` and `REALTIME_NAMESPACE` defaults to `SERVICE_NAME`.

## SERVICE_MANIFEST

`SERVICE_MANIFEST=chat,identity:no-routes,audit:no-routes` loads those three modules plus every `kind: 'infra'` overlay in the plugin list (`service-manifest.ts`, `applyServiceManifest`). Infra overlays always load, they cannot be flagged, and their own dependencies count.

The manifest must be closed: every module a listed module `dependsOn`, and every module that binds a port a listed module requires. Chat `dependsOn` `identity` and `audit`, and identity `dependsOn` audit, so those are the floor. A split also refuses to boot when it would skip a control the rest of the install enforces (a geo check, an RG limit, the admin guard's permission resolver), as long as the plugin list contains the module that binds it.

You do not have to work the closure out by hand. Boot once with the short manifest. The failure lists every missing module and why, and ends with a line to paste:

```
Add them: SERVICE_MANIFEST=chat,identity:no-routes,audit:no-routes,iam,...
```

It keeps your flags. An unknown id, an unknown flag, or `:no-routes` on an infra overlay also fails the boot, with the known ids in the message.

### Loading a module for its ports only

`id:no-routes` binds the module's ports, runs its event handlers and jobs, and discards its router, so it serves no HTTP route. Use it for a dependency whose surface this service must not expose. In the chat service above, `identity:no-routes` gives chat its session resolver without serving sign-in, phone-login or 2FA.

The router factory still runs, because several modules build their service and schedule their jobs inside it. A factory that guards its HTTP surface receives `options.mounted` and skips the guard when it is `false`. Identity refuses to build its router when the geo check is unbound, unless it is loaded `:no-routes`, so a process that serves auth routes without the compliance module fails closed instead of skipping the country gate.

## SERVICE_NAME: the consumer group

The broker (`RedisStreamsBroker`) creates one consumer group per (topic, `SERVICE_NAME`). Replicas of one service share the group and compete, so each event reaches one replica. Two different services each get their own copy of every event. Two services on the same name split the stream and each sees half.

So: one distinct `SERVICE_NAME` per service, and the same value on all replicas of that service.

The name is a durable identity. Never rename one in production. Renaming strands the old group's delivered-but-unacked entries, and the new group is created at the stream tail, so anything published while the group did not exist is not delivered to it. That is also why `createApp` will not derive the name from `SERVICE_MANIFEST`: that list reorders and grows.

## REALTIME_NAMESPACE: the realtime prefix

Channels, signals, presence and session revocation are all prefixed with it. A player's socket is held by whichever process accepted the connection, so a message published by any service has to land on the same keys the others read. Give every service of one deployment the same value. Two deployments sharing one Redis must use different values.

Presence and revocation follow it too. With the namespaces split, a session revoked in the main API would not reach a socket held by the chat service.

Because it defaults to `SERVICE_NAME`, a monolith that never set either keeps its keys as they are. When you add a second service, pin the existing one explicitly: `SERVICE_NAME=monolith` (leave it, do not rename) and `REALTIME_NAMESPACE=monolith`.

## Once per deployment or once per service

By default a module's `ctx.events.on` handler runs once in each service that loads the module. Handlers are at-least-once and deduplicated per consumer through `processed_events`.

Some work must happen once per deployment however many services load the plugin. The audit writer is the example (`packages/core/src/audit/plugin.ts`): it would write one row per service otherwise. It passes `{ consumerGroup: 'audit' }` as the third argument of `ctx.events.on`, and `createApp` scopes it to `<REALTIME_NAMESPACE>/audit`. Every service loading the audit plugin competes in that one group, and two deployments sharing a Redis stay apart. Reach for the same option in your own plugin only when a duplicate would be wrong, not as a default.

## Database

The cheap default is one shared Postgres. Services load the modules they need against the same database, and nothing about reads changes. That is a good place to stop for a long time.

Giving a module its own schema or database changes what is allowed across the boundary:

- A read that used to join the module's tables, or run in the same transaction as a write, becomes either a synchronous command port call or a read model the other side builds from events.
- An event that reports a committed change on a money, compliance, KYC or account-status path uses `emitInTransaction`, which needs the outbox row in the same database as the state change. It cannot span two databases.
- Money and any answer needed now never travel over events.

Decide this per module, later. Splitting the process does not force it.

## Worked example: chat next to the main API

Chat's HTTP routes sit under `/chat/*` (player) and `/backoffice/chat/*` (staff), and its handlers and jobs (room purge, moderation expiry) run wherever the module loads.

The main API can drop chat. Of the modules it keeps, only `player-management` needs a chat port (`CHAT_BLOCK_READER`, for player search), and it requires the port, not the `chat` module. `social` and `chat-commands` `dependsOn` chat, so they stay with the chat service. Load the `chat-remote` plugin in the main API and it binds `CHAT_BLOCK_READER` and `CHAT_TRANSFER_CHECK` to the chat service's internal API (ADR-0054, ADR-0060):

```
SERVICE_NAME=monolith
REALTIME_NAMESPACE=monolith
SERVICE_MANIFEST=<every module>,chat-remote
CHAT_SERVICE_URL=https://chat.internal   # the chat service's private origin
CHAT_SERVICE_NAME=chat                   # its SERVICE_NAME, the default
INTERNAL_API_SECRETS=<shared secret>
```

The main API then has no chat tables to migrate and serves no chat route. The boot fails when `chat-remote` is in the manifest and a module that needs a chat port finds none, which is what an unset `CHAT_SERVICE_URL` looks like. It also fails in the other direction: the chat plugin refuses to boot while `CHAT_SERVICE_URL` is set, so one process never binds the ports twice. In production the URL must be https unless `CHAT_SERVICE_ALLOW_HTTP=true` (a mesh that encrypts the hop).

The chat service serves the two routes only to the callers it names, and refuses every caller while the lists are unset:

```
CHAT_BLOCK_READER_CALLERS=monolith       # POST /internal/v1/chat/blocks/{excluded,blocked,blockers}
CHAT_TRANSFER_CHECK_CALLERS=monolith     # POST /internal/v1/chat-commands/transfer-check
```

Both lists are comma-separated `SERVICE_NAME`s. They guard against misconfiguration only, because one install-wide secret signs as any caller name. A module that moves money in chat needs `chat-commands` on the chat service, which serves the transfer check.

Failures close. Neither read is cached, and each call times out at 500ms. A block read that cannot be answered (timeout, network, 5xx) throws a 503 `SERVICE_UNAVAILABLE`, never an empty list. A transfer check that cannot be answered refuses the transfer as `chat_unavailable` through `checkChatTransfer`. The remote check also holds no block lock: the chat service answers on a transaction of its own, so a block committed after the answer and before the caller's money commits is not seen. The local binding closes that window with a shared lock held until the caller's transaction ends. A remote caller narrows the window by calling `checkChatTransfer` a second time after its debit and ledger rows, just before commit, and rolling back on any refusal, or when a counterpart is now blocked. It never closes fully without a lock shared across the two services.

Chat service, on a database of its own and reaching identity over its internal API:

```
SERVICE_NAME=chat
REALTIME_NAMESPACE=monolith
SERVICE_MANIFEST=chat,chat-commands,social,identity:no-routes,iam:no-routes,audit:no-routes   # then add what the boot asks for
INTERNAL_API_SECRETS=<shared secret>
IDENTITY_SERVICE_URL=https://api.internal   # the service that serves identity and iam
CHAT_BLOCK_READER_CALLERS=monolith
CHAT_TRANSFER_CHECK_CALLERS=monolith
```

On the service that serves identity and iam, name the chat service so it may read accounts, sessions (admin security included) and admin grants: `ACCOUNT_READER_CALLERS`, `SESSION_RESOLVER_CALLERS` and `ADMIN_PERMISSION_CALLERS` (`POST /internal/v1/iam/admin-permissions/{grants,super-admin}`) each list `chat`. Unset refuses every caller, and without `chat` in `ADMIN_PERMISSION_CALLERS` every admin check on the chat service is refused. Chat reads grants through `IDENTITY_SERVICE_URL`, the same origin as accounts and sessions, so one service must serve both identity and iam. Chat caches no grant of its own, so a revoked admin loses access as soon as the iam owner's cache purges, and an unreachable owner refuses the request with a 503 rather than reading as "no grants". The chat service's own database holds no role assignments, so `iam:no-routes` there binds only controls and the remote resolver wins.

`CHAT_CONTEXT_SEND_POLICY` and `CHAT_ROOM_ACCESS` overrides must load on the chat service: that is where the send and room checks run.

A play-refusal rule bound to `PLAY_ELIGIBILITY` reaches chat's invites through the account read. The database-backed port reads tables the chat database does not hold, so with `IDENTITY_SERVICE_URL` set chat does not consult it; the identity service does, when an account read sets `playEligibility`, which only the invite checks do (`excluded` is core's own `checkPlay`, plus the bound port when an overlay replaced it, resolved at call time, for player accounts core admits). Every other read, a search or a mention lookup included, never calls the overlay port, so a port that throws cannot fail them. An invite to a player the identity service reports as excluded is withheld, read fresh on every invite, and an unreachable identity service refuses the invite with a 503 before anything is written. Load the overlay that rebinds `PLAY_ELIGIBILITY` on the identity service, not on chat.

The chat service runs the audit module against its own database and ships its audit rows to the chain through the audit outbox (ADR-0055). Its database needs the audit migration (`audit_outbox` and `audit_outbox_rejected`, plus `audit_log` when no `AUDIT_DATABASE_URL` is set), and with a separate chain database every process loading audit, chat included, sets `AUDIT_DATABASE_URL` and `AUDIT_SHIPPER_DATABASE_URL`.

Both get the same `REDIS_URL` and `AUTH_SECRET`; the chat service's `DATABASE_URL` names its own database. Route at the load balancer by path prefix:

```
/chat/*                     -> chat service
/backoffice/chat/*          -> chat service
/social/*                   -> chat service
/chat-command/*             -> chat service
/backoffice/chat-command/*  -> chat service
/*                          -> main API
```

Route every prefix. Without the staff ones, the staff routes go to `/*` and 404 once the main API stops serving chat.

Any realtime endpoint your frontend uses for chat must be routed to the chat service too; check which module serves it.

A main API that does not load chat runs none of chat's handlers or jobs. The chat service runs them all.

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
3. Deploy the main API with `chat-remote` in the manifest and `CHAT_SERVICE_URL` set, without `chat`.

Until step 3 the main API still loads chat, so chat handlers run in both services, idempotently. Its consumer group does not move, so step 3 loses nothing. The chat service's group is new: it starts at the stream tail, so deploy it (step 1) before you depend on it.

Rollback is routing and the manifest. Redeploy the main API with plain `chat` in the manifest, unset `CHAT_SERVICE_URL`, and point the prefixes back at it.

## Checklist

- Each service has a distinct, stable `SERVICE_NAME`.
- Every service of the deployment has the same `REALTIME_NAMESPACE`.
- Every process with a manifest sets all three variables.
- Each queue has a consumer; each route prefix has exactly one owner at the load balancer.
- Once-per-deployment work uses `{ consumerGroup }`.

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
