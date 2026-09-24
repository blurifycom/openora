---
'@openora/core': minor
---

The exchange-rate module now keeps its configured currencies warm instead of leaving a
hot-path caller (the RG limit gate, rank accrual, a social transfer, or anything else
converting inside a locked transaction) to hit the vendor synchronously once a rate goes
hard-stale. A new schedule refreshes every crypto currency the operator lists plus every
displayed fiat currency roughly every 30 seconds, so a request only ever reads a fresh row
from the cache.

A failed vendor call previously cooled down for exactly `providerTimeoutMs`, so a vendor
outage added a full timeout stall to every call for as long as it lasted. The cooldown is
now its own `exchangeRate.failureCooldownMs` config knob, defaulting to 30 seconds -
independent of and longer than the timeout, so an outage fails fast from the last-known
row instead of waiting out the vendor on every request.

`useExchangeRate`/`useExchangeRates` now set `staleTime: 60_000` and
`refetchOnWindowFocus: false`, matching the reader's own fresh window - a remount or a tab
refocus inside that window no longer re-fetches a rate that hasn't changed server-side.
