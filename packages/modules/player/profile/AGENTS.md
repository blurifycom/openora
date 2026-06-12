# profile module - AGENTS.md

## What this module does

Player-facing self-profile (core, free edition). Owns the `player` table - the
igaming profile (displayName, country, currency, language, lifecycle status, KYC
status, level, lifetime stats) linked to an identity `user` by `userId`. Exposes
the `profile.*` oRPC surface: the signed-in player reads and edits their own
preference fields. The caller is resolved from the verified better-auth session
(`getUserId`); these routes are NOT admin-guarded.

The **admin** side of player management (PAM - list/search/update/ban players,
registration analytics) is a separate PREMIUM package,
`@oss-premium/player-management`, which reads this module's `player` table via the
`@oss/modules/player/profile/schema` subpath. See ADR-0020.

## Tables (`src/schema/index.ts`)

| Table    | Purpose                | Notes                                              |
| -------- | ---------------------- | -------------------------------------------------- |
| `player` | igaming player profile | `userId` references identity `user` (ID-only, no FK) |

## oRPC routes (`src/router/index.ts`)

| Procedure        | Method | Auth                 | Service call                          |
| ---------------- | ------ | -------------------- | ------------------------------------- |
| `profile.get`    | GET    | session (`getUserId`)| `getMyProfile(userId)`                |
| `profile.update` | PATCH  | session (`getUserId`)| `updateMyProfile(userId, input)`      |

`get`/`update` lazily materialise a default `player` row on first access, so a
freshly-registered user always has a profile.

## Do

- Keep self-service logic here; the `player` table lives here.
- Admin/operator player operations belong in the premium PAM package, never here.

## Don't

- Add admin-guarded routes - this is the player's own surface.
- Import another module's code (read tables via the `/schema` subpath).
