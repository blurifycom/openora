---
'@openora/core': patch
---

Wallet and gaming money-movement domain events (`wallet.deposit.completed`, `wallet.withdrawal.*`, `wallet.manual_adjustment.created`, `gaming.round.started`, `wallet.bonus_rollover.completed`) validated `currency` against the ISO-3-only `CurrencyCodeSchema`. The asset catalog ships 4+ character tickers (USDT, USDC), so any event carrying one failed payload validation and was silently dropped - no notification, no audit projection, no analytics. These events now validate against `CurrencyTickerSchema`, the same schema the wallet module's own contract already uses for a money ticker. A consumer that narrowly typed a handler's `currency` field to a 3-letter code should widen it.
