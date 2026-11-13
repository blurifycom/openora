---
'@openora/core': minor
'@openora/testing': patch
---

The audit chain can live in a database of its own. Set `AUDIT_DATABASE_URL` and run the audit `migrate({ adminUrl, auditUrl })`: it creates the database and its writer role (read and append only), and the shipper appends there through the new `AUDIT_DRIZZLE` token. Modules read the chain through the new `AUDIT_READER` port, `AuditService.verifyChain({ fromSeq, fromHash })` resumes from an anchor, and a player's RG history shows a limit change before it ships. `flushAudit` drains into the chain's own database when there is one.
