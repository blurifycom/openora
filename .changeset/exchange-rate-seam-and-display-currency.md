---
'@openora/core': minor
---

**New `fx/exchange-rate` module and the display currency built on it.** Amounts can now be _rendered_ in a currency the player picked. Nothing here moves money: no balance, ledger row, or transaction amount is written in a converted value, and no conversion result is ever persisted beside one.

**The rate seam.** Two optional adapter ports, `CRYPTO_EXCHANGE_RATE_PROVIDER` and `FIAT_EXCHANGE_RATE_PROVIDER`, which core never binds - an install with neither simply has no rates. Against them sits a self-bound `EXCHANGE_RATE_READER` over the `exchange_rate_quote` table, routing each currency to its rail through `railFor` and upserting per pair. A provider that throws, is unbound, or returns null leaves the previous good row in place rather than clobbering it. See the read-through cache changeset in this release for how the reader decides when to call a provider.

`railFor` moves from wallet's service into the shared wallet-tx contracts zone so fx can reuse it without crossing a module boundary. Wallet re-exports it under the same name, so existing call sites are unaffected.

New config `platformConfig.exchangeRate`: `pivot` (comparison currency for a cross rate when a provider quotes against only one currency, default `USD`), plus the freshness thresholds documented in the read-through cache changeset. **`pivot` is a comparison unit, not a system base currency** - the platform deliberately has none; each player has their own operating currency in `wallet.currency`.

**Display currency.** A nullable `player.displayCurrency` column, where null means "never chosen" and is therefore never defaulted over. New self-service routes `GET`/`PUT /profile/display-currency` resolve the effective currency in order: the explicit pick, then the currency the player holds the most value in, then the wallet's own currency. Resolution reads `WALLET_READER.getBalances` and converts through `EXCHANGE_RATE_READER`, skipping any pair with no rate - it never calls a vendor and never throws on a missing rate. A set is audited as `player.display_currency.set`. The canonical crypto and fiat list is operator-overridable via `platformConfig.displayCurrencies`, the same pattern as `WalletConfigSchema.cryptoCurrencies`.

New batched route `GET /exchange-rate/rates` takes one target and several sources in a single call, so a balances view issues one request rather than one per asset. A pair with no rate returns `null` in its own entry instead of failing the whole call.

New subpath exports `@openora/core/fx`, `/fx/contracts`, `/fx/server`, `/fx/react`, plus the usual per-module `contracts`/`schema`/`plugins`/`migrate` subpaths for `exchange-rate`. React hooks for all of the above ship in `pam/react` and the new `fx/react`. Migration included.

**Deliberately out of scope**, and tracked separately: storing the rate and its timestamp alongside a transaction or on any ledger or audit row, and any real rate vendor - core ships the ports only.
