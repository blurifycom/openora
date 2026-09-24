# Gaming

The game catalog, category ordering, and round management module. `docs/catalog.json` is the exhaustive list of this module's tables, routes and events. This file focuses on per-category game ordering - the most complex surface.

## What this module owns

- **The game catalog** - providers, categories, tags, games, and category membership.
- **Game rounds** - a player's engagement with a game; started by the player, concluded by the provider.
- **Category ordering** - every category has a configurable sort with a materialized, job-written effective order, manual drag-and-drop positioning, and pinned slots.
- **Read ports** - `GAME_CATALOG_READER` for cross-module access (lobby sections, promotions) and `GAMING_COMMANDS` for wallet integration (`accumulateExternalRound`, `setGameAvailability`).

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

Attribute and stats sorts (RTP, volatility, release date, revenue, plays, average bet) are deliberately not built in. Core has no read model for them, and an operator writes them as a `GameSortDefinition` in an overlay plugin that rebinds the catalog.

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

## Admin routes

| Method | Path                                             | Purpose                                                                          |
| ------ | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| GET    | `/backoffice/gaming/categories`                  | List all categories (active, inactive, with counts)                              |
| GET    | `/backoffice/gaming/categories/{id}`             | Read a category's full config (sort key, direction, params)                      |
| POST   | `/backoffice/gaming/categories`                  | Create a category (slug, name, translations, sort config defaults to `'manual'`) |
| PATCH  | `/backoffice/gaming/categories/{id}`             | Update a category's config, including sort key/direction/params                  |
| GET    | `/backoffice/gaming/categories/{id}/games`       | Paginated list of category members with `position` and `pinnedPosition`          |
| PUT    | `/backoffice/gaming/categories/{id}/games/order` | Reorder games (switches to `'manual'` sort)                                      |
| PUT    | `/backoffice/gaming/categories/{id}/games/pins`  | Update pinned slots (replace-all write)                                          |
| GET    | `/backoffice/gaming/sort-options`                | List available sort definitions with their JSON Schemas for a config UI          |

## Audited events

Every admin change to sort config, order, or pins emits an event carrying the actor's id, the before/after state, and optional request-origin metadata.

- **`gaming.category.updated`** - `sortKey`, `sortDirection`, `sortParams`, etc. changed. Carries before/after snapshots of the full category config.
- **`gaming.category.games_reordered`** - Manual reorder via the PUT route. Carries `before`/`after` as the full ordered game-id lists (every member, not only previously-positioned ones), `sortKeyBefore`/`sortKeyAfter` to show the mode switch, and `sortDirectionBefore`/`sortDirectionAfter` plus `sortParamsBefore`/`sortParamsAfter` to show the direction/params reset a reorder always performs.
- **`gaming.category.pins_updated`** - Pins replaced via the PUT route. Carries `before`/`after` as ordered lists of `{ gameId, position }` objects.

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
