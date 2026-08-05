# Audit

Read this before adding a state-changing action or changing audit storage, events, or exports.

- Every mutation that changes player, operator, money, KYC, permissions, or configuration state must produce an audit record with actor, resource, outcome, and meaningful before/after state. Use a declared domain event after commit, or write through `AUDIT_WRITER`; money-path records join the business transaction.
- `AUDIT_WRITER` is sealed. Only the audit module binds it; overlays and domains must not replace it.
- Audit rows are append-only. Never add update or delete behavior, and never invent a topic outside `domainEventSchemas`.
- Preserve the hash-chain protocol: serialize concurrent appends, include the full persisted record in the hash, and use a stable deep key order for JSON values. Insert the final hash with the row, never as a later update.
- A denial audit signal must come from a real backend request; a client-side route guard's redirect never reaches the server, so it is never a substitute. Every authorization denial emits the same event regardless of where it is thrown - a service-level check that denies before ever reaching a shared guard (e.g. `AdminGuard.assert()`) still needs its own explicit emit, not just the guard's.
