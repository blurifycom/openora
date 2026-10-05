---
'@openora/core': patch
---

Financial analytics (`summary`, `ggr`) now accept crypto tickers such as USDT and BCH in `currency`. The ISO 4217 check failed output validation for any crypto ledger row, so both endpoints returned 500 and the GGR trend stayed empty.
