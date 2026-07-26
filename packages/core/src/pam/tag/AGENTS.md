# Tag

Rule-based player tagging. A tag lands on a player either manually (admin, actor stamped) or by rule evaluation on subscribed wallet/identity/compliance events; `playerTag` keeps the full assign/removal history rather than a current-state row, so removals stay auditable.

## Invariants

- Sticky tags (`isSticky=true`) are never auto-removed - only a manual removal clears them.
- Rule-driven assignment is threshold-based and deterministic per rule type; re-evaluating the same event is a no-op.
- The daily inactive-player sweep (cron `0 2 * * *`) is idempotent - it may re-run without duplicating assignments.

## Extension points

- Provides `PLAYER_TAGS` for other modules to query a player's active tags.
- Consumes wallet + identity reader ports; `dependsOn` those modules.
