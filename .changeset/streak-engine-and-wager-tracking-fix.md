---
'@openora/core': minor
---

Fixed `wager()` in the bonus wagering engine: a real-money bet placed with no active bonus grant
never reached `WAGER_TRACKING`, so the rank ladder (and anything else on that port) only advanced
for a player mid-bonus. It now reports the bet at its full stake regardless.

Added a daily streak engine alongside the rank ladder in `promo/gamification`: a config-driven
daily qualifying wager, a milestone list (bonus, gift-drop, and rank-rakeback-boost rewards), a
UTC close job, an idempotent milestone-payout job, and a top-5 leaderboard. Bound onto the same
sealed `WAGER_TRACKING` port as the rank ladder through a small internal fan-out, so a bet is
still reported to both from one call site.
