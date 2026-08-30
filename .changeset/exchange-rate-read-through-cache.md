---
'@openora/core': minor
---

**`EXCHANGE_RATE_READER` is now a read-through cache, not a cache-or-nothing reader.** Product-approved reversal of the original fx design: a player request MAY now reach a vendor. Three age bands off the stored quote's own last-write time (`exchange_rate_quote.updatedAt`):

- **Fresh** (age < `freshTtlMs`, default 60s): the stored quote answers with no vendor call.
- **Soft-stale** (`freshTtlMs` <= age < `hardMaxAgeMs`): the stored quote answers immediately, and a background refresh is kicked off - a slow or dead vendor never delays the caller, and a background failure is logged, never thrown.
- **Hard-stale** (age >= `hardMaxAgeMs`, default 15 min) or nothing stored at all: fetched synchronously, bounded by `providerTimeoutMs` (default 2s), and fails closed to `null` on any error so a limit check or a deposit is never left hanging on a vendor. A pair going hard-stale and unavailable logs at `error` - it is an availability event, deposits on that rail start being refused.

Concurrent callers for the same currency-vs-pivot leg share one in-flight vendor call (single-flight, keyed by the normalized pair) - without this a TTL expiry under load would turn one refresh into as many vendor calls as there are concurrent callers. A cross-pair derivation still takes the staler of its two legs, now with the age bands applied per-leg before combining.

**Removed:** `ExchangeRateRefreshService`, its job queue/schedule, and `platformConfig.exchangeRate.refreshCron` - there is no more cron, the reader itself is the only thing that ever talks to `CRYPTO_EXCHANGE_RATE_PROVIDER`/`FIAT_EXCHANGE_RATE_PROVIDER`. Replaced by `platformConfig.exchangeRate.freshTtlMs`, `.hardMaxAgeMs`, and `.providerTimeoutMs`.

`convert()`'s signature and null-on-unavailable contract are unchanged.
