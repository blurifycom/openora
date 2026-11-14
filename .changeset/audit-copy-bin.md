---
'@openora/core': minor
---

Adds the `openora-audit-copy` bin: copies the legacy `audit_log` of a main database into the chain's own database byte-equal and resumable, installs a fence that refuses later inserts into the old table, verifies the copied chain, and can roll the switch back while the audit database holds no row the main one lacks.
