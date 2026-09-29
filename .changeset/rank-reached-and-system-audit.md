---
'@openora/core': patch
---

Public `GET /promo/ranks/reached` returns how many players have reached each rank (holding it or any rank above). `@openora/core/audit/server` exports `recordAuditInTransaction`, so a deploy step outside the container appends to the audit hash chain the same way `AUDIT_WRITER` does; `promo.rank_ladder.installed` and `promo.rank_config.installed` join the audit actions. `seedRankLadder` accepts a transaction.
