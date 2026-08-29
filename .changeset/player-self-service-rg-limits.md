---
'@openora/core': minor
---

Responsible-gambling money limits are now enforced, and a player can set, lower, raise, drop and confirm them themselves - plus start their own break or self-exclusion.

**Behaviour change on two existing routes.** Both keep their paths and both return a different shape:

- `PUT /compliance/limits` (`upsertLimit`) applies immediately for a first limit or a lower one, and files a cool-down request for a raise. Output is now `LimitViewSchema` - the limit plus its usage in the current window (`used`/`remaining`/`pct`) and any pending request. `amount` is always the limit **in force**, so a pending raise does not move it.
- `DELETE /compliance/limits/{id}` (`deleteLimit`) files a removal request instead of deleting. The limit keeps applying until the player confirms. Output is `LimitViewSchema`, no longer `{ success: true }`.

`GET /compliance/limits` and the admin `GET /compliance/players/{userId}/rg` return the same view, so a compliance officer can see a pending player request and its deadline.

**New player self-service routes** (all resolve the subject from the session and take no `userId`):

- `GET /compliance/rg/me` - the whole RG screen in one read.
- `POST /compliance/limits/{id}/pending/confirm` - applies a request whose cool-down elapsed. `CONFLICT` before the cool-down (`CooldownNotElapsedError`) and after the confirmation window (`LimitChangeExpiredError`). Returns `null` when the confirmed request was a removal.
- `DELETE /compliance/limits/{id}/pending` - cancels a request, always immediately.
- `POST /compliance/rg/cooling-off` (24h / 7d / 30d) and `POST /compliance/rg/self-exclusion` (6 / 12 / 24 / 60 months, or permanent, behind `confirm: true`). Both go through the existing `RgService`, so they kill sessions, block login and mail the player exactly as the admin routes do. Lifting an exclusion stays admin-only.

**New port `RG_LIMITS`** (`checkDeposit` / `checkWager`), bound by compliance and resolved **optionally** by wallet and gaming - an install without compliance has no limits to enforce. Where bound: `WalletService.deposit` refuses before the PSP call, `GamingService.startRound` refuses before a launch token is issued, and `WalletCommandsService.debit` refuses a `bet` **inside the debit transaction, after the wallet row's `FOR UPDATE`** - so concurrent bets serialize and cannot jointly pass one limit. An on-chain crypto deposit is deliberately not gated - the funds are already on the chain - and raises the `limit_threshold` flag for compliance instead. See ADR-0036.

**`loss` limits are not enforced** (they still raise the 80% flag). Net loss is stakes minus winnings and this platform records no winnings - `game_round.winAmount` is `'0'` on every row while win-crediting waits on a sealed `GAME_OUTCOME_AUTHORITY` (ADR-0034). Enforcing against that would stop a player at their _staked_ total, including one who is up on the window.

**Known limitation: the deposit gate does not serialize.** A PSP round-trip sits between the check and the credit, so two deposits started at once can both pass and together exceed the limit. A row lock cannot span a vendor call and refusing after the charge would strand the money; closing it needs a durable reservation, tracked separately. The excess raises the `limit_threshold` flag, as an on-chain deposit's does.

**One error class for every RG refusal**: `RgLimitExceededError`, exported from `@openora/core/contracts` beside the port (wallet raises it, gaming maps it, no cross-module import). It carries `data.reason` from the new `RG_LIMIT_ERROR_REASONS` enum plus `limitType`/`period`/`limit`/`used`. Branch on `reason`, never on the status code (`startRound` also returns `CONFLICT` for an exclusion, `deposit` for an idempotency-key reuse, and `CooldownNotElapsedError`/`LimitChangeExpiredError` share it for opposite reasons) and never on the message.

**Limit changes are serialized per limit.** Read, classify and write happen inside one advisory-locked transaction, and confirm/cancel/expiry pin their write to the exact request that was read - otherwise two concurrent lowerings both measure against the old value and the later lands as an un-cooled raise, and a confirm racing a lowering resurrects the value the player just moved past. An **admin** write still applies immediately in either direction: that is the compliance function, permissioned and audited, and the cool-down invariant is scoped to the player's own path.

**`RG_FLAG_THRESHOLD_PCT` moved to `@openora/core/contracts`** so a client can colour a usage bar at the same number the back-office flag fires at. It was only reachable from server code before.

**Fix: `loss` limits counted gross stakes.** `spendFor` measured a loss limit with `sum(betAmount)`, so a player who staked 1000 and won 900 was recorded as having lost 1000. It is now net (stakes minus winnings, floored at zero). The 80% flag had been reporting this wrongly since it was written.

**Fix: player-initiated limit changes were invisible in the back-office RG history and misattributed in the audit log.** The player path emitted `compliance.limit.upserted`, a topic the RG history card does not render, and the audit mapper hard-coded `actorType: 'admin'` for every `rg.*` event. Both paths now emit `rg.limit.set` carrying `initiatedBy: 'player' | 'admin' | 'system'`, and the audit actor is read from it. `compliance.limit.upserted` / `compliance.limit.removed` are no longer emitted by core; the topics stay in the catalog for existing subscribers.

**Fix: changing a limit did not re-run the 80% evaluation.** `rg.limit.set` is now an eval trigger, so lowering a limit below current spend raises the flag at once instead of at the player's next deposit or round.

New events `rg.limit.change_requested` / `_confirmed` / `_cancelled` / `_expired`, all audited. Version bumps: `rg.limit.set` -> 3, `rg.cooling_off.activated` -> 2, `rg.self_exclusion.activated` -> 4 (all: `initiatedBy` added).

New config `platformConfig.responsibleGambling`: `limitIncreaseCooldownHours` (default 24) and `limitChangeConfirmationWindowHours` (default 168). A jurisdiction number, not a platform constant.

New columns on `user_limit` (`pending_kind`, `pending_amount`, `pending_minutes`, `pending_requested_at`, `pending_effective_at`, `pending_expires_at`) - migration included.

**Known limitation.** Spend sums mix currencies (`0.001 BTC + 20 USDT` counts as `20.001`) because `user_limit` carries no currency. This previously only mis-set a review flag and now makes a money decision. Tracked separately; `TODO`s mark both read sites.
