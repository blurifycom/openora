---
'@openora/core': minor
---

Persist a player's display decimal places. `player.display_decimal_places` (nullable, 0-18) is
returned as `decimalPlaces` on `GET/PUT /profile/display-currency` and set through the new
`PUT /profile/display-decimal-places` (audited as `player.display_decimal_places.set`); `null`
clears the pick. React: `useSetDisplayDecimalPlaces` from `@openora/core/pam/react`. Presentation
only - the value never rounds a stored or submitted amount.
