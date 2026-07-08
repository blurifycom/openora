# Tag

Rule-based player tagging with event-driven and manual assignment. Tables: `tag` (key, isSticky), `playerTag` (assign/removal history with actor/reason audit trail), `tagRule` (per-tag evaluation thresholds: amount, days, count).

Routes: `createTag`/`deleteTag` (admin), `assignPlayerTag`/`removePlayerTag` (admin or event-driven, stamps actor), `listPlayerTags`, `listAssignableTags`, admin rule CRUD (`listTagRules`, `upsertTagRule`).

Subscribes to wallet.deposit.completed, wallet.withdrawal.completed, identity.user.login, compliance.kyc.submitted, compliance.kyc.updated; evaluates rules on each event. Daily scheduled job (cron 0 2 \* \* \*, idempotent) runs inactive-player sweep. Provides `PLAYER_TAGS` port for other modules to query active tags. Depends on wallet and identity modules for reader ports.

Sticky tags (isSticky=true) are not auto-removed; manual assignment/removal always works. Event-driven assignment is rule-threshold-based and deterministic per rule type.
