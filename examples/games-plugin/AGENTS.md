# AGENTS.md - consumer-games-plugin example

A worked example showing how a downstream consumer (Consumer, or anyone) plugs a
proprietary PvP game into the OSS igaming platform using `definePlugin` - without
touching any core module.

## What this example shows

| Concern                  | How it is solved                                                               |
| ------------------------ | ------------------------------------------------------------------------------ |
| New game type + routes   | `ctx.controllers.add(CrashController)` - no core file edited                   |
| Swap the game provider   | `ctx.providers.add({ provide: GAME_ADAPTER, useClass: ConsumerGameAdapter })` |
| React to platform events | `ctx.events.on('wallet.deposit.completed', handler)`                           |
| Custom lobby card        | `ctx.slots.fill('game-lobby-extra', { type: 'crash-game-card', ... })`         |
| New DB tables            | `prisma.partial.prisma` + `ctx.prisma.extend(...)`                             |

## Three extension points demonstrated

### 1. `ctx.controllers`

```typescript
ctx.controllers.add(CrashController);
```

Registers a NestJS controller that exposes four oRPC routes under the `crash`
namespace. The controller is built with the same `@Implement` + `implement().handler()`
pattern as core modules - there is no special plugin API to learn.

### 2. `ctx.events`

```typescript
ctx.events.on('wallet.deposit.completed', async (payload: unknown) => {
  // narrow payload, then act
});
```

Subscribes to a platform event emitted by the wallet module. The handler runs
inside the API process. For work that may take more than a few milliseconds,
emit a job event instead and handle it in `apps/worker`.

Always narrow `payload` from `unknown` - never cast directly to a concrete type.

### 3. `ctx.slots`

```typescript
ctx.slots.fill('game-lobby-extra', {
  type: 'crash-game-card',
  label: 'Crash',
  path: '/crash',
});
```

Injects an opaque descriptor into the named UI slot. The active UI provider
(e.g. `@oss/ui-provider-shadcn`) reads the slot map at render time and decides
how to display it. For a React component, pass a component reference instead of
a plain object - both are valid `component` values.

## How to adapt this for a real game

1. Replace the in-process `Map` store in `crash.router.ts` with injected
   `PrismaService` calls backed by the tables in `prisma.partial.prisma`.
2. Replace `ConsumerGameAdapter` with a real adapter that calls your game engine
   via an injected port (not a raw fetch - see the port pattern in
   `packages/modules/gaming/src/service/ports.ts`).
3. Swap `console.log` in the deposit handler for an `EventBus.emit(...)` call
   targeting the bonus module.
4. Replace the plain object in `ctx.slots.fill` with a React component imported
   from your private UI package.

## How to register this plugin

Add one line to `extensions.config.ts` at the repo root:

```typescript
import consumerGames from './examples/consumer-games-plugin/plugin.js';

export default [
  // ... other plugins
  consumerGames,
];
```

Then run:

```bash
pnpm regen   # merges prisma.partial.prisma into packages/platform/db/prisma/schema.prisma
pnpm dev     # boots the API with the plugin loaded
```

## File map

```
examples/consumer-games-plugin/
  plugin.ts                         - definePlugin entry point
  prisma.partial.prisma             - CrashRound + CrashBet tables
  src/
    schemas/crash.schemas.ts        - all Zod schemas for this plugin
    game/crash.game.ts              - pure provably-fair multiplier function
    provider/consumer-game-provider.ts - GameAdapter implementation
    router/crash.router.ts          - oRPC contract + NestJS controller
```

## Rules this example follows

- No `any` - `unknown` + narrowing is used for all untyped payloads.
- All schemas live in `src/schemas/` - none are inlined in the router.
- No imports from other extensions.
- `.js` extensions on all local imports (Node16 module resolution).
- Short dashes (-) only, never long dashes.
- Not registered in `extensions.config.ts` - registration is an explicit manual step.
