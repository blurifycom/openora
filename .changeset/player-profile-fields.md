---
'@openora/core': minor
---

The player profile gains the fields a registration flow's optional profile step collects: `firstName`, `lastName`, `dateOfBirth`, and `phone` on the `player` table, surfaced on `PlayerSchema` and writable through `PATCH /profile`. All four are nullable - the step is skippable, and rows written before this release keep reading fine.

- `phone` is the player's self-declared contact number and is deliberately **not** unique. `user.phoneNumber` stays the unique, verified phone-login credential; making this one unique too would turn an optional profile field into a phone-enumeration oracle (a duplicate would answer `409` for a number the caller does not own) and would let anyone permanently squat a stranger's number before they verify it. A future phone-verification flow promotes `player.phone` to `user.phoneNumber`.
- `dateOfBirth` is a plain calendar date (`YYYY-MM-DD`, no timezone) and is rejected on input when it puts the player under 18.
- `country` on this route is now held to an ISO 3166-1 alpha-2 code rather than any string, so it can actually be compared against the `jurisdictions` and `blockedCountries` lists in the igaming config.

Fixes a `500` on the same route: `UpdatePlayerProfileInputSchema` accepted an update carrying no fields, which reached `db.update().set({})` and threw. It now requires at least one field and answers `400`, matching the identity module's own profile-update contract.

Consumers apply the `profile` module's `0003` migration (`pnpm db:migrate`).
