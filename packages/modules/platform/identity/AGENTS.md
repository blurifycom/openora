# identity module - AGENTS.md

Authentication and user management. Wraps better-auth for email+password flows.

## Routes

| Method | Path               | Handler                     |
| ------ | ------------------ | --------------------------- |
| POST   | /identity/register | signUpEmail via better-auth |
| POST   | /identity/login    | signInEmail via better-auth |
| POST   | /identity/logout   | signOut via better-auth     |
| GET    | /identity/me       | getSession via better-auth  |

Contract slice: `packages/contracts/orpc-contract/src/identity.ts`
Router factory: `src/router/index.ts` (`createIdentityRouter`)

## Drizzle tables

Defined in `src/schema/index.ts`:

- `user` - core user record (id, name, email, emailVerified, image, role, isActive)
- `session` - active sessions with token + expiry
- `account` - OAuth accounts (credential provider uses password field)
- `verification` - email verification tokens

better-auth manages all queries to these tables (the tables are passed to `createAuth({ db, schema })` in `IdentityService`). Do not query them directly from other modules - emit events or call `me` instead.

## Events emitted

| Event                      | Payload              | When                    |
| -------------------------- | -------------------- | ----------------------- |
| `identity.user.registered` | `{ userId: string }` | After successful signUp |
| `identity.user.login`      | `{ userId: string }` | After successful signIn |

Subscribe via `ctx.events.on('identity.user.registered', handler)` in a plugin.

## Ports

`KycAdapter` (token: `KYC_ADAPTER`) - KYC vendor adapter. Not registered by default.
Implement in `adapters/<vendor>/` and register via `ctx.provide(KYC_ADAPTER, () => new MyKycAdapter())`.

## Extension points

- Add new routes: `/scaffold-route identity <method> <path>`
- Add social login: update `createAuth` in `@oss/auth` with social provider config
- Add KYC flow: implement `KycAdapter`, register in plugin, call from `IdentityService`
- Add profile fields: extend the `user` `pgTable` in `src/schema/index.ts`, add field to `UserSchema` in `@oss/shared-schemas`

## Do

- Inject `DrizzleService` from `@oss/db` for any custom queries beyond what better-auth provides (`this.drizzle.db.select().from(user).where(eq(...))`; operators from `drizzle-orm`, tables from `../schema/index.js`)
- Receive the `EventBus` as a constructor argument (plugin.ts passes `c.get(EVENT_BUS)`)
- Keep business logic in the service, not the controller
- Call `this.events.emit(...)` AFTER the DB write succeeds

## Don't

- Import from other modules
- Query `user`/`session`/`account`/`verification` tables directly from other modules
- Add HTTP-specific logic (status codes, headers) to `IdentityService`
- Construct your own DB client inside handlers - inject `DrizzleService`

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- `list-routes module=identity` shows the new/changed route(s) (e.g. `identity.register`).
- No `boundaries/dependencies` lint errors (no cross-module code imports; read other modules' tables only via the `@oss/modules/<group>/<name>/schema` subpath).
- New tables: added to `src/schema/index.ts`, `pnpm regen` run, migration committed.
