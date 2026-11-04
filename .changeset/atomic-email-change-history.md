---
'@openora/core': minor
---

A player email change now commits in one transaction with its `identity.email.changed` audit row and outbox event, and every new account records the email it registered with (new nullable `user.registered_email` column; run migrations). The identity module now depends on the audit module (breaking): a `SERVICE_MANIFEST` that lists `identity` must also list `audit` (for example `audit:no-routes,identity:no-routes`), or boot fails with `Plugin "identity" depends on "audit" which is not registered`. Hosts that load every module in one process need no change.
