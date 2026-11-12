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

The main API cannot drop chat: `player-management`, `social` and `chat-commands` `dependsOn` it, and `compliance` depends on `player-management`, so the boot fails and asks for chat back. It loads chat for its ports only and stops serving its routes:

```
SERVICE_NAME=monolith
REALTIME_NAMESPACE=monolith
SERVICE_MANIFEST=<every module>,chat:no-routes
```

Chat service:

```
SERVICE_NAME=chat
REALTIME_NAMESPACE=monolith
SERVICE_MANIFEST=chat,identity:no-routes,audit:no-routes   # then add what the boot asks for
```

Both get the same `DATABASE_URL`, `REDIS_URL` and `AUTH_SECRET`. Route at the load balancer by path prefix:

```
/chat/*             -> chat service
/backoffice/chat/*  -> chat service
/*                  -> main API
```

Route both prefixes. Without the second, the staff chat routes go to `/*` and 404 once the main API stops serving chat.

Any realtime endpoint your frontend uses for chat must be routed to the chat service too; check which module serves it.

Chat's handlers and jobs still run in the main API because it loads the module, so exclude chat queues there with `JOB_WORKERS` if they should run only in the chat service. A job queue is consumed by every process that loads its module. `JOB_WORKERS` narrows what a process consumes (names, `prefix*`, `!` to exclude), and every queue needs a consumer somewhere.

## Rollout

1. Deploy the chat service with the new `SERVICE_NAME`, taking no traffic. Chat is now loaded in two services, each with its own group, so chat event handlers run twice during the overlap. They are idempotent by contract, but watch for it.
2. Move `/chat/*` and `/backoffice/chat/*` to the chat service at the load balancer.
3. Deploy the main API with the manifest that loads chat as `chat:no-routes`.

The main API keeps loading chat under its existing `SERVICE_NAME`, so its consumer group does not move and step 3 loses nothing. The chat service's group is new: it starts at the stream tail, so deploy it (step 1) before you depend on it. Because both services load chat, chat event handlers keep running in each, idempotently, for as long as the split lasts.

Rollback is routing. Redeploy the main API with plain `chat` in the manifest so it serves chat routes again, then point both prefixes back at it.

## Checklist

- Each service has a distinct, stable `SERVICE_NAME`.
- Every service of the deployment has the same `REALTIME_NAMESPACE`.
- Every process with a manifest sets all three variables.
- Each queue has a consumer; each route prefix has exactly one owner at the load balancer.
- Once-per-deployment work uses `{ consumerGroup }`.
