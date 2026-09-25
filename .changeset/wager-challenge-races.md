---
'@openora/core': minor
---

Wager challenges (leaderboard races) in `promo/gamification`: an operator-configured window of wagering volume, ranked, with a prize pool split across paid positions.

A race is priced in one currency, with `startAt`/`endAt`, a `prizePool`, and `positions` (`{ position, prize }[]`, prizes summing to at most the pool). `WAGER_TRACKING` gains a fourth consumer alongside the rank ladder, rakeback and streak: every real-money bet in an eligible product (the race's own product list, same convention as the rank ladder and streak) accrues into the player's standing for every race currently open, converted into the race's currency at the rate of the moment. Bonus-funded stake is never counted.

`GET /promo/races` lists open races; `GET /promo/races/{raceId}` returns the race's own config, a top-3 podium, a capped leaderboard (up to 100 ranked entries total - real pagination is left for a race that outgrows that), the caller's own standing (their true position and wagered total, never affected by their own privacy setting), and how much more they need to wager to reach the next paid position. Every other player's username on the leaderboard is partially masked, or shown as `Incognito` for a player who set the new `hideUsernameOnLeaderboards` profile preference (`PATCH /profile`) - their own row is never masked to themselves, and the setting never touches their standing or prize eligibility.

`POST /backoffice/promo/races` and `PUT /backoffice/promo/races/{raceId}` create and edit a race, audited like the rank ladder; editing is refused once a race has closed. A short recurring job closes a race once its window ends, freezes final standings (ties broken by whoever reached the total first), pays every position through a direct real-cash credit (idempotent - a retried tick never pays twice), and emits `promo.race.won` per winner, which now sends both an in-app notification and an email.
