# Gaming

The game catalog, category ordering, and round management module. `docs/catalog.json` is the exhaustive list of this module's tables, routes and events. This file focuses on per-category game ordering - the most complex surface.

## What this module owns

- **The game catalog** - providers, categories, tags, games, and category membership.
- **Game rounds** - a player's engagement with a game; started by the player, concluded by the provider.
- **Category ordering** - every category has a configurable sort with a materialized, job-written effective order, manual drag-and-drop positioning, and pinned slots.
- **Rule-based category membership** - a category can be populated by a rule instead of by hand: a pipeline of clauses over an operator-extensible catalog of rule kinds (built-ins: providers, tags, most played); see below.
- **Read ports** - `GAME_CATALOG_READER` for cross-module access (lobby sections, promotions) and `GAMING_COMMANDS` for wallet integration (`accumulateExternalRound`, `setGameAvailability`) and catalogue imports (`notifyGamesCreated`).

## Per-category game ordering

A category's games are ordered by a configurable sort definition. The operator can choose from built-in sorts (`manual`, `name`) or overlay-supplied custom sorts (RTP, volatility, revenue, plays) without forking core. An active category can also have pinned games that hold fixed slots regardless of sort, and the operator can drag and drop to manually reorder any time.

### Sort definitions and the GAME_SORT_CATALOG seam

A sort definition is a `GameSortDefinition<Params>`:

- **`key`** - the stable sort identifier (e.g., `'manual'`, `'name'`, `'rtp'` in an overlay).
- **`directions`** - an ordered array of supported directions; the first is the default (e.g., `'asc'` only for manual, `'asc' | 'desc'` for name or stats).
- **`paramsSchema`** - a real Zod schema (not a duck-typed parser), so the admin route `/backoffice/gaming/sort-options` can emit its JSON Schema for a dynamic config UI.
- **`rank(input)`** - an async function returning an ordered list of game ids from any source: a SQL query, an external ranking service, a cached analytics rollup. The function receives:
  - **`categoryId`** - the category to order.
  - **`gameIds`** - every current member of the category (including inactive games).
  - **`direction`** - the operator's chosen sort direction.
  - **`params`** - parsed sort-specific parameters (e.g., `{}` for built-ins, `{ window: 7 }` for a 7-day revenue window in an overlay).

`defineGameSort()` validates and wraps a definition; `createGameSortCatalog()` assembles a map keyed by sort key. The gaming plugin binds `GAME_SORT_CATALOG` to a catalog of the two built-ins via `createDefaultGameSorts()`. The catalog is a non-sealed (replaceable) token: an overlay rebinds it to add custom definitions (e.g., an attribute or stats sort) alongside or instead of the built-ins, without touching this module.

A sort definition receives every category member, including games an operator marked inactive. A definition _may_ filter or re-order based on active state, name, metadata, external data, or anything else it can access - but it must return game ids only, never compute SQL order expressions or fixed enums. The seam stays definition-agnostic: core merges pins and materializes the result into the database; definitions only answer "what order would this category be in?".

### Built-in sorts

**`manual`** - the operator's own drag-and-drop order, stored on each category-game link. `rank()` reads `position` (nullable, per-member) from the database; games without a position sort last by name. This sort is write-only on the positions themselves (the reorder route, below) and read-only by the definition.

**`name`** - alphabetical by game name, both ascending and descending. This sort ignores `position` entirely; dragging a game does not change its alphabetical rank until the category switches back to manual or another operator-supplied sort.

Attribute and stats sorts (RTP, volatility, release date, revenue, plays, average bet) are supplied as `GameSortDefinition`s in an overlay plugin that rebinds the catalog. Round-count reporting is available through `ADMIN_GAME_REPORTING` and powers the `most_played` membership rule below; core does not yet ship a corresponding sort. Money-based sorts need an operator-defined currency policy.

### Configuration on a category: sort key, direction, and params

A category carries:

- **`sortKey`** - which sort definition to apply (e.g., `'manual'`, `'name'`, `'rtp'`). A category always has one; the default is `'manual'`.
- **`sortDirection`** - the chosen direction within that definition (e.g., `'asc'` or `'desc'` for name, `'asc'` only for manual). `null` means "the definition's default", its first declared direction. A PATCH that sends `sortDirection: null` resets to that default; omitting the field keeps the current direction, unless the key changed or the definition no longer offers it, in which case it also falls back to the default.
- **`sortParams`** - a JSON object of sort-specific settings (e.g., `{}` for built-ins, `{ window: 7 }` for a 7-day stats sort). Validated against the definition's `paramsSchema` when a sort-config change writes them.

The sort config is read-only on admin reads and changed via `PATCH /backoffice/gaming/categories/{id}` with `sortKey`, `sortDirection` and `sortParams`. A sort key unknown to the catalog, a direction the definition does not offer, or params its `paramsSchema` rejects are all rejected with a `GameSortConfigInvalidError`.

Concurrent admin writes to a category's sort config, order, or pins are last-write-wins, like every other admin PATCH in this module: there is no client-supplied version to detect a stale read. Each write path locks the category row `FOR UPDATE` inside its own transaction (`GameCategoryService.lockCategoryRow`), so two concurrent writes serialize rather than racing, and every write is recorded in the audit trail with a before/after snapshot - see [Audited events](#audited-events) below.

### Materialized ranks: a job-computed effective order

Core **never computes a category's order at request time**. A background job (`gaming.category.rank`, one per category, triggered by category changes) is the _only_ writer of the `rank` column on `game_category_game` - the materialized effective order.

- **`position`** (nullable, per-member) - the operator's own manual order, written only by the reorder route (PUT). Set only for games an admin dragged into their new position. `null` means "I was never explicitly positioned by an operator."
- **`rank`** (nullable, per-member) - the job-materialized effective order, written only by the rank job. A run assigns every member a 0-based sequence number within the category. `null` means "the job hasn't ranked me yet", which holds only until the category's first run.

Splitting the two means a category can switch from `name` to `manual` and back without losing the operator's manual order in between. The next rank run simply re-reads `position` under the `manual` sort and materializes a new sequence.

Every public and admin read orders by `rank` first (ascending), falling back to name and id for any game not yet ranked (the first run may not complete before a player loads the category). This ordering is defined once in `categoryGameOrder()` in the shared catalog helper, used identically by the public list route and the `GAME_CATALOG_READER` port.

The ranking service claims a category version before computing. Each configuration, order, pin, membership, name, or playability change increments that same version inside its transaction. Before writing ranks, the service locks the category and checks the claimed version. An invalidated result never touches the materialized order, even if the configuration changed away and back. A stale success or failure retries from current inputs, up to three attempts; continued contention leaves work for the periodic sweep. A claim only succeeds on a dirty category, so a queued job whose work another run already finished returns without computing.

Every relevant mutation also records durable dirty work. A claim bumps the same marker, so a run whose adapter fails leaves the category dirty and retryable. The marker uses the database wall clock at the write, rather than the transaction start time; a writer that began before an earlier successful run cannot make its newer work appear already processed.

The periodic sweep runs every minute and enqueues at most 200 dirty categories, oldest first. Claims move attempted categories behind older pending work, preventing a failing category from monopolizing a full backlog. Unknown definitions, invalid parameters and adapter errors preserve both the previous ranks and the last successful evaluation time. They remain eligible for a later sweep, so fixing a temporary dependency failure or restoring an overlay does not require another configuration change. Each failure increments `rankFailures`, and the sweep skips the category until 2 minutes have passed since its last attempt, doubling per consecutive failure up to an hour; a success resets the count. A write that enqueues directly still runs at once.

A successful write records the exact database dirty timestamp as its success timestamp under the version lock. This preserves PostgreSQL timestamp precision: rounding through a JavaScript date would otherwise leave a successful category appearing dirty. Definition validation and option discovery live in the sort service; event selection and the sweep live in the trigger service. Plugin code only wires those services to events, jobs, and routes.

### Pinning a game to a fixed slot

`game_category_game.pinnedPosition` (nullable, 0-based, `CHECK (pinned_position >= 0)`) fixes a game's slot regardless of the category's current sort.

The merge happens in core, never inside a `GameSortDefinition`. `rank()` keeps exactly the contract it always had (an ordered list of member ids) and stays completely unaware pins exist. After sanitizing a definition's output to the category's actual members, `GameSortRankingService` merges pins via the pure `mergePinnedOrder` function:

1. Split the sanitized order into playable and unplayable members (`playableGameCondition` - the game and its provider are both active and the vendor has not marked the game unavailable).
2. Merge pins into the playable members only. Each pinned game claims its slot; a slot past the end of the playable list clamps to the last position. Several overflowing pins stack at the tail in ascending slot order relative to each other. A pin whose game isn't in the playable list this pass (omitted by the definition, or currently unplayable) is silently ignored.
3. Append the unplayable members after, in the definition's own order.

**Slots are relative to what a player can see** - a pin at slot 0 always means "first among visible games." A playability change (a game or its provider flips `isActive`, a game's vendor-availability flag flips) can move a pin's absolute position even though nothing about the pin itself changed, so every write that can flip playability marks affected categories dirty.

A definition never sees pins, so custom sorts get pinning for free. The merge is in exactly one place, so its correctness properties hold regardless of how many sort definitions exist. A pin composes with _any_ current or future sort with no cooperation required from that sort's author.

Max pins per category is 100 (`GAME_CATEGORY_PINS_MAX`).

### Reorder: dragging any game switches the category to manual sort

The reorder route (`PUT /backoffice/gaming/categories/{id}/games/order`) materializes a manual order from a list of game ids and automatically sets `sortKey: 'manual'`, `sortDirection: null`, `sortParams: {}` in the same transaction. This holds even when the category was already manual - the write is simply a no-op in that case. Rejecting with a field error if `'manual'` is not bound in the catalog gives the same "unknown sort key" failure mode the sort-config PATCH has.

The visible order is preserved across the switch. The dragged `gameIds` get positions `0..n-1`. Every member NOT listed keeps its current effective order (rank, name, id - the same fallback ordering every reader uses) seeded as positions `n, n+1, …` in one SQL statement - never `null`. A game the operator never touched does not visibly jump.

Input validates:

- **`gameIds`** - must be unique, 1 to 2000 items, and every id must be a member of the category. Non-members are rejected with `CategoryGameNotMemberError`; duplicates fail validation before the request reaches the handler.

Output returns:

- **`sortKey`, `sortDirection`, `sortParams`** - the new sort config (always `'manual'`, `null`, `{}`), so the caller's config view stays consistent without a follow-up GET.

The event `gaming.category.games_reordered` carries `before`/`after` as the _full_ pre- and post-drag effective order (every member, not only ones with a pre-existing manual position - a category's first-ever drag still audits a complete list, never `[]`), plus `sortKeyBefore`/`sortKeyAfter` and `sortDirectionBefore`/`sortDirectionAfter` and `sortParamsBefore`/`sortParamsAfter`, so the audit trail shows the mode switch and the direction/params it silently resets, not only the position change.

A pin is untouched by any of this: dragging a different game only ever changes that game's position, and the pin still wins the pinned game's slot on the very next rank run.

### Read paths: public and admin

**Public read** (`GET /gaming/games?categoryId=...`) - ordered by the category's materialized rank, with fallback to name. `position`, `rank`, and `pinnedPosition` never appear on public game schemas.

**Admin read** (`GET /backoffice/gaming/categories/{id}/games`) - paginated list of category members. Each game carries:

- **`position`** (nullable) - the operator-written manual position, `null` if never explicitly positioned.
- **`pinnedPosition`** (nullable) - the operator-written pin slot, `null` if not pinned.

The list is returned in the same effective order players see (`categoryGameOrder()`), not in raw `position` order, so a drag-and-drop UI shows what it is about to reorder even while the category is on an automatic sort. A reorder or pin change is reflected here only once the rank job has run, so a client that re-reads immediately may still see the previous order.

**Cross-module read** (`GAME_CATALOG_READER.listPlayableGamesInCategory(categoryId, { limit })`) - called by lobby sections and promotions. Returns an ordered list of playable games (active game, active provider, not vendor-unavailable), capped at `limit`. Falls back to name ordering for any game not yet ranked.

The lobby module's own `lobby_category`/`lobby_category_game`/`featured_slot` system is unaffected and unaware of gaming sorts. A lobby section that surfaces a gaming category still reads it through `GAME_CATALOG_READER`, so it inherits the category's configured order automatically - but the lobby layout itself is cached (by default 30 seconds), so a re-rank triggered here can take up to that TTL to become visible in lobby sections.

## Rule-based category membership

A category's `membershipMode` is `manual` (the default: an admin adds and removes games) or `rule` (`GameCategoryMembershipService` owns the category's `game_category_game` rows). A rule is **materialized** into the same link table a manual category uses, so every reader - the public list, `GAME_CATALOG_READER`, the lobby, sorting, pins - works unchanged and never evaluates a rule at request time.

Three services split the work, mirroring how sorts are laid out: `GameCategoryRuleService` runs rules against the catalog and never writes (resolve, save-time checks, preview, options); `GameCategoryMembershipService` writes what a rule resolves to (`evaluate`, and the job entry point); `GameCategoryMembershipTriggerService` decides when a category is re-evaluated (event matching, the debounce, the sweep, `notifyGamesCreated`).

### The rule: an ordered pipeline of clauses

`membershipRule` (`GameCategoryRuleSchema` in `@openora/core/contracts`) is a list of 1-10 clauses, `{ key, params }`. Each `key` names a **rule definition** in `GAME_CATEGORY_RULE_CATALOG`; `params` is that definition's own shape. The clauses run in order as a pipeline: the first matches over the whole catalogue, and every later clause only narrows what the one before it left. So clauses AND together, a ranking clause belongs last, and the same key may appear twice (two `tags` clauses require a tag from each).

```json
[
  { "key": "providers", "params": { "providerIds": ["..."] } },
  { "key": "tags", "params": { "tagIds": ["..."] } },
  { "key": "most_played", "params": { "periodDays": 7, "limit": 20 } }
]
```

Built-in definitions (`createDefaultGameCategoryRules()`):

| Key           | Params                                | Matches                                                                                                |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `providers`   | `providerIds` (1-50)                  | a game of ANY listed provider                                                                          |
| `tags`        | `tagIds` (1-50)                       | a game carrying ANY listed tag                                                                         |
| `most_played` | `periodDays` (1-365), `limit` (1-500) | the `limit` most-played of the games it is given, by completed rounds in the window, most played first |

`providers` and `tags` match a game whether or not it is playable, exactly as a manual category can hold an inactive game; readers already hide unplayable games from players. `most_played` declares no `isAffectedBy`: it aggregates the round table, so it is refreshed by the sweep (which its rolling window needs anyway) and on demand, never by a burst of catalogue events. It ranks **playable games only**, so an inactive game never takes a slot a player would see as a gap. Ties break on game id, and a game with no completed round in the window never qualifies, so a quiet catalogue yields fewer than `limit` games rather than arbitrary ones.

`most_played` counts come from `ADMIN_GAME_REPORTING.listGamePerformance` - the same aggregation as the game performance report, so an overlay that rebinds the report also drives it. A round count is currency-neutral, so there is nothing to convert on a multi-currency catalogue. A money-based ranking (revenue, volume) is deliberately not built in: it would sum amounts across currencies unconverted. An operator who wants one writes it as a definition in an overlay, where the currency policy is theirs to choose.

A rule may match at most `GAME_CATEGORY_RULE_MATCH_MAX` (5,000) games - checked after every clause, not only the last, so a ranking clause does not rescue a filter that is too broad.

### Rule definitions and the GAME_CATEGORY_RULE_CATALOG seam

The catalog mirrors `GAME_SORT_CATALOG`: a non-sealed token the gaming plugin binds to the three built-ins, which an overlay rebinds to add its own kinds (new releases, a game type, a metadata attribute such as RTP, an exclusion) alongside or instead of them. `defineGameCategoryRule()` takes:

- **`key`** - a slug in the same shape as a sort key.
- **`paramsSchema`** - a real Zod schema. Params are JSON (`z.json()`, since they live in a `jsonb` column and on audit events) and are parsed with it when a rule is saved; the parsed value is what is stored, so it must still be plain JSON and again before every run; `GET /backoffice/gaming/category-rule-options` publishes its JSON Schema for a rule-builder UI.
- **`resolve({ params, candidateIds, now })`** - returns matching game ids, best first, from any source it likes. `candidateIds` is `null` for a rule's first clause (query the catalogue rather than loading it) and otherwise the games left so far. The result is de-duplicated, stripped of malformed ids and cut down to `candidateIds`, so a careless definition cannot widen the set or fail the link writes.
- **`validate(params)`** (optional) - a problem only a lookup can find, as a message, or `null`; a throw is treated as a rule that cannot be saved. The built-ins use it to reject a provider or tag id that does not exist.
- **`isAffectedBy(params, change)`** (optional) - whether a catalogue change (`providerIds`, `tagIds`, `playabilityChanged`) could alter the match, for event-driven re-evaluation. A definition without it is refreshed by the sweep and on demand only.
- **`exposesReporting`** (optional) - set when the result reveals reporting data an admin with only `game-config:view` must not infer, such as a revenue ranking. Previewing it, sending it in a create or update (in either mode), switching a category that stores it to rule mode, or re-evaluating it needs `report:view` on top of the route's own `game-config` permission. Once saved, the category's members are the ranking's result and are readable with `game-config:view`, like any category's. No built-in sets it: `most_played` shows only which games are popular, with no figures, and that is what the resulting category shows players anyway.

**A rule that does not resolve never empties a category.** Saving validates every key, the definition's parameters, their bounded JSON representation, and optional `validate` lookups before opening the configuration transaction. Unknown keys, invalid parameters, and failed reference validation reject the save with `400` (`GameCategoryRuleInvalidError`), including a switch to rule mode that reuses a stored rule. Saving does not run the resolver during validation: it commits the configuration, then awaits one evaluation, which may retry stale computations. If resolution throws or exceeds the match cap, the save returns the persisted configuration with `membershipLastError` and preserves the previous members and last successful evaluation time. Preview and explicit evaluation reject an unresolvable or over-cap result with `400` (`GameCategoryRuleInvalidError`, `GameCategoryRuleTooBroadError`).

A later background failure also preserves members and records its reason; the hourly sweep provides the next attempt instead of an immediate retry loop. A stored rule that no longer parses against `GameCategoryRuleSchema` (the column reads it as `null`) is an unresolvable rule, never a manual category, so changing that schema needs a backfill for existing rules. A category reports its state on three fields:

- **`membershipEvaluatedAt`** - when its games last matched the rule; written by successful evaluations only.
- **`membershipAttemptedAt`** - successful and failed evaluations, including a run that exhausts its retries while its category snapshot is still current. Stale attempts cannot replace newer status. The sweep orders by it (least recently attempted first), so a rule that never resolves goes to the back instead of holding a batch slot on every pass.
- **`membershipLastError`** - why the last evaluation failed (this module's own message, never a definition's raw error), cleared by the next success. Switching the category back to manual clears this and `membershipAttemptedAt`, keeping the stored rule.

Every clause's kind and parameters are checked before resolution begins. An empty match from an earlier clause cannot conceal a removed kind or invalid parameters in a later clause.

So a stuck rule shows an old `membershipEvaluatedAt` next to a recent `membershipAttemptedAt` and a reason, never as freshly evaluated.

### Mode switches and the manual-write guard

- **manual -> rule** needs a rule in the same PATCH, or one stored earlier. The category is evaluated before the PATCH returns; a successful evaluation **replaces** its hand-picked games with the rule's matches. A failed evaluation preserves them and returns the error in the category status.
- **rule -> manual** keeps the current games and the stored rule. The games become ordinary manual rows an admin can remove.
- **While a category is in rule mode** no manual write may add or remove its games: `PATCH /backoffice/gaming/games/{id}` whose `categoryIds` would add or drop a rule-mode category, and `POST /backoffice/gaming/games/bulk/categories` naming one, are rejected whole with `409 CONFLICT` (`GameCategoryRuleManagedError`). On the single-game `PATCH`, re-sending a rule-mode category the game is already in is not a change and is accepted; the bulk route has no such case and rejects any rule-mode category it names. Reordering and pinning stay available - they arrange members, they do not choose them. A pin on a game the rule later drops goes with the row.

`game_category_game.source` (`manual` | `rule`) records who wrote each row. Nothing reads it yet: it exists so a later "manual additions on top of a rule" feature can tell the two apart without a backfill that could not recover the answer. Today a rule-mode category holds only `rule` rows (the first evaluation converts or removes whatever was there), and a switch back to manual relabels them `manual`.

### When a rule is re-evaluated

Evaluation is a diff inside one transaction - insert the new matches, delete the stale rows, leave the rest (and their `position`/`pinnedPosition`) untouched - followed by a rank run when anything moved. It is idempotent, so every trigger below is safe to repeat.

| Trigger                                                                                                                   | Re-evaluates                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| category created in, switched to, or re-ruled in rule mode                                                                | that category, synchronously                                                                    |
| `POST /backoffice/gaming/categories/{id}/membership/evaluate`                                                             | that category, synchronously                                                                    |
| `gaming.game.updated` (provider, tags or `isActive` changed)                                                              | rules naming a moved provider/tag; a provider or `isActive` change is also a playability change |
| `gaming.games.bulk_updated` `add_tags`                                                                                    | rules naming an added tag                                                                       |
| `gaming.tag.deleted`                                                                                                      | rules naming the tag                                                                            |
| `gaming.games.bulk_updated` `set_active`, `gaming.provider.updated` (`isActive` flip), `gaming.game.availability_changed` | no built-in; an overlay kind whose `isAffectedBy` reads `playabilityChanged`                    |
| `gaming.games.created`                                                                                                    | rules naming the new games' providers/tags                                                      |
| the `gaming.category.membership-sweep` schedule (hourly, `MEMBERSHIP_SWEEP_CRON`)                                         | every rule-mode category                                                                        |

Which rules a change reaches is each clause's own `isAffectedBy`; the right-hand column describes the built-ins. `gaming.tag.created`/`updated` and `gaming.provider.created` cannot change any built-in's match set and are not subscribed. Event-driven runs go through the `gaming.category.membership` queue, one job per affected category; changes arriving within `MEMBERSHIP_EVENT_DEBOUNCE_MS` are merged per process and looked up once, so a sync flipping a thousand games costs one category scan and one job per affected category. The sweep takes at most `MEMBERSHIP_SWEEP_BATCH_LIMIT` categories per pass, least recently attempted first.

**Core has no game-insert path.** Games arrive from whatever imports the catalogue - an aggregator sync overlay, a seed - writing `game` rows directly. Such an importer should call `GAMING_COMMANDS.notifyGamesCreated?.({ gameIds })` after it commits; that emits `gaming.games.created` (in batches of 1,000 ids). The method is optional on the port type so an overlay that already rebinds `GAMING_COMMANDS` keeps compiling; core's binding always provides it. An importer that does not is still covered by the sweep, which is also the only trigger a `most_played` clause has as its rolling window moves and as new rounds complete (round completion deliberately does not trigger an evaluation - it is the hot money path).

### Lock order

Each membership evaluation atomically increments and claims `membershipSeq` before resolving its rule. It may write membership or failure status only while that sequence and the rule configuration remain current under the category lock. A newer evaluation, a membership configuration change (including a change away and back), or an affected catalogue event invalidates the claim. Stale successes and failures are discarded and re-evaluated from current data, at most three times. Ranking and unrelated category updates do not invalidate membership claims. This uses the same claim, compute, locked version check, and retry protocol as `rankSeq`, with independent counters for independent operations.

Every writer of `game_category_game` takes locks in the order **game rows, then the `game_category` row, then the link rows**. `updateGame` holds its game `FOR UPDATE` and then takes `FOR KEY SHARE` on the categories it touches; the bulk add does the same over its scope. The evaluator's link inserts would lock game rows (the foreign-key check) _after_ the category, so it instead reads the rule and the current members unlocked, locks the games it is about to insert `FOR KEY SHARE`, then locks the category `FOR UPDATE` and re-computes the diff; if the locked state disagrees with the unlocked read (rule edited, mode switched, another match appeared) it restarts, at most three times. The category `FOR UPDATE` conflicts with the `FOR KEY SHARE` the manual writers take, which is what makes the rule-mode guard race-free against a concurrent mode switch. For the same reason a mode switch evaluates _after_ its config transaction commits, not inside it, and a PATCH checks its rule (`normalizeRule`: definition code, on its own pooled connections) _before_ opening that transaction. Under the row lock it only confirms that the rule it checked is still the one in play, and restarts when a concurrent PATCH changed it - at most three times, then `409` (`GameCategoryUpdateContendedError`).

## Admin routes

| Method | Path                                                     | Purpose                                                                          |
| ------ | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| GET    | `/backoffice/gaming/categories`                          | List all categories (active, inactive, with counts)                              |
| GET    | `/backoffice/gaming/categories/{id}`                     | Read a category's full config (sort key, direction, params)                      |
| POST   | `/backoffice/gaming/categories`                          | Create a category (slug, name, translations, sort config defaults to `'manual'`) |
| PATCH  | `/backoffice/gaming/categories/{id}`                     | Update a category's config, including sort key/direction/params                  |
| GET    | `/backoffice/gaming/categories/{id}/games`               | Paginated list of category members with `position` and `pinnedPosition`          |
| PUT    | `/backoffice/gaming/categories/{id}/games/order`         | Reorder games (switches to `'manual'` sort)                                      |
| PUT    | `/backoffice/gaming/categories/{id}/games/pins`          | Update pinned slots (replace-all write)                                          |
| GET    | `/backoffice/gaming/sort-options`                        | List available sort definitions with their JSON Schemas for a config UI          |
| GET    | `/backoffice/gaming/category-rule-options`               | List the bound rule kinds with their params JSON Schemas for a rule-builder UI   |
| POST   | `/backoffice/gaming/categories/rule-preview`             | Match count and first page for an unsaved rule; writes nothing                   |
| POST   | `/backoffice/gaming/categories/{id}/membership/evaluate` | Re-evaluate a rule-mode category now                                             |

`POST`/`PATCH` on a category also accept `membershipMode` and `membershipRule`. The preview needs `game-config:view`. The preview, a create or update that sends a rule or switches to rule mode, and an on-demand evaluation also need `report:view` when a clause's definition sets `exposesReporting` - none of the built-ins does.

## Audited events

Every admin change to sort config, order, or pins emits an event carrying the actor's id, the before/after state, and optional request-origin metadata.

- **`gaming.category.updated`** - `sortKey`, `sortDirection`, `sortParams`, etc. changed. Carries before/after snapshots of the full category config.
- **`gaming.category.games_reordered`** - Manual reorder via the PUT route. Carries `before`/`after` as the full ordered game-id lists (every member, not only previously-positioned ones), `sortKeyBefore`/`sortKeyAfter` to show the mode switch, and `sortDirectionBefore`/`sortDirectionAfter` plus `sortParamsBefore`/`sortParamsAfter` to show the direction/params reset a reorder always performs.
- **`gaming.category.pins_updated`** - Pins replaced via the PUT route. Carries `before`/`after` as ordered lists of `{ gameId, position }` objects.

- **`gaming.category.membership_evaluated`** - one evaluation of a rule-mode category that changed its games, or that an admin asked for. Carries `trigger` (`admin` | `event` | `schedule`), `matchedCount`, `addedGameIds`, `removedGameIds` and `relabeledCount` (rows kept but handed from `manual` to `rule` ownership). `actorId` is the admin for an on-demand or mode-switch run and the system actor (the zero UUID) otherwise; a scheduled or event-driven run that adds, removes and relabels nothing emits nothing. A mode or rule change itself is on `gaming.category.updated`, whose snapshots now carry `membershipMode` and `membershipRule` (defaulting to `manual`/`null` when replaying an older event).

An event recorded before this feature carries no sort fields at all. The schemas default `sortKey` to `'manual'`, `sortDirection` to `null` and `sortParams` to `{}` on parse, so replaying an older event still parses and reports what those categories actually were.

## Design notes

**Why definitions return ordered ids rather than SQL order expressions or a fixed enum:**
Definitions live outside core, in overlays or the operator's own repo. Returning ids lets them pull from any source - a SQL query scoped to gaming tables, a call to an analytics service, a cached rollup - without exposing core's schema or query builder. The enum approach would require a core change and migration for every new sort an operator invents.

**Why order is never computed at request time:**
A request-time resolver would pull an external call and a full-category sort onto the hot public list-games path. Materializing ranks into the database decouples the public read from a sort definition's complexity and latency: the public read is one indexed join, whatever the sort does. The cost is staleness. A change normally re-ranks within the second, because the write also enqueues the job directly; the sweep interval only bounds how long a lost enqueue can go unnoticed, and the lobby layout cache adds its own TTL on top for lobby sections.

**Why `position` and `rank` are separate:**
A category can switch from `name` to `manual` and back. `position` (operator-written, manual only) and `rank` (job-materialized, any sort) being separate columns means the operator's manual order persists across sorts. Merging them would require either losing the manual order on a sort switch or storing the same data twice (one for each sort the category uses), complicating the model.

**Why the operator gets no version guard, but the rank job gets one:**
Every other admin PATCH in this platform is last-write-wins, and sort configuration, reorder, and pins follow that convention: concurrent writes serialize on the category row lock and both writes land in the audit trail, but neither caller must prove it read the latest state first. The internal version guard serves a different purpose: it prevents background work from applying an order computed before another run or an input mutation. An invalidated attempt must recompute before it can write.
