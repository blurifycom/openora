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
Controller: `src/router/index.ts` (`IdentityController`)

## Prisma tables

- `user` - core user record (id, name, email, emailVerified, image)
- `session` - active sessions with token + expiry
- `account` - OAuth accounts (credential provider uses password field)
- `verification` - email verification tokens

better-auth manages all queries to these tables. Do not query them directly from other modules - emit events or call `me` instead.

## Events emitted

| Event                      | Payload              | When                    |
| -------------------------- | -------------------- | ----------------------- |
| `identity.user.registered` | `{ userId: string }` | After successful signUp |
| `identity.user.login`      | `{ userId: string }` | After successful signIn |

Subscribe via `ctx.events.on('identity.user.registered', handler)` in a plugin.

## Ports

`KycPort` (token: `KYC_PORT`) - KYC vendor adapter. Not registered by default.
Implement in `adapters/<vendor>/` and register via `ctx.providers.add({ provide: KYC_PORT, useClass: MyKycAdapter })`.

## Extension points

- Add new routes: `/scaffold-route identity <method> <path>`
- Add social login: update `createAuth` in `@oss/auth` with social provider config
- Add KYC flow: implement `KycPort`, register in plugin, call from `IdentityService`
- Add profile fields: extend `user` model in `prisma.partial.prisma`, add field to `UserSchema` in `@oss/domain-schemas`

## Do

- Use `PrismaService` for any custom queries beyond what better-auth provides
- Use `@Inject(EVENT_BUS)` to receive the event bus
- Keep business logic in the service, not the controller
- Call `this.events.emit(...)` AFTER the DB write succeeds

## Don't

- Import from other modules
- Query `user`/`session`/`account`/`verification` tables directly from other modules
- Add HTTP-specific logic (status codes, headers) to `IdentityService`
- Call `createPrismaClient()` inside handlers - inject `PrismaService`
