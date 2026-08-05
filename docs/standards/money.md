# Money

Read this before changing a balance, ledger, payment, wager settlement, or money-moving command.

- Amounts are decimal strings backed by Postgres `NUMERIC`; never use JavaScript floating-point arithmetic for stored or compared money. Keep arithmetic and conditional balance updates in the database transaction.
- A money mutation needs a durable database idempotency/concurrency guard inside its transaction. Cache-only reservations, preflight reads, and events are not correctness guards. A replay returns the original result and does not create another ledger entry, event, or audit record.
- Debit, every corresponding credit, the business record, and its required audit entry commit or roll back together. Do not debit a remainder that is not credited somewhere.
- Treat external payment calls as non-transactional. Persist a recoverable state first, make every settlement transition idempotent, and compensate a failed held withdrawal exactly once.
- Auto-approval and any missing risk/KYC signal fail closed to manual review. A system decision records its actor and rationale before contacting the payment rail.
- Use the wallet command port for cross-domain transfers and pass the caller transaction. Never reach into wallet tables or rely on an event for a transfer that must be atomic.
- A runtime-editable auto-approval config (a DB-backed threshold, cap, or exclusion set an admin can change without redeploy) must fail closed to manual review if the config row is unexpectedly missing - never silently default or create it outside its explicit admin write path.
- A per-entity override narrows only the specific gate it targets. It must never implicitly bypass an independent gate (e.g. a risk or exclusion check) that the override was not designed to touch.
