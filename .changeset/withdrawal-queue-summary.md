---
'@openora/core': minor
---

New admin route `GET /wallet/withdrawals/summary` (`wallet.withdrawals.summary`) for the withdrawal review queue header: pending and on-hold counts, the queued amount per currency, and the average wait of pending withdrawals. It takes the queue's own filters minus paging, status and sort, so the figures always describe the rows the list pages through. Guarded by `withdrawal:view`, like the list.
