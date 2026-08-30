---
'@openora/core': minor
---

`/gift`, `/rain`, and `/donate` let the sender choose which currency they send in, and the
recipient receives that exact same currency - no swap or exchange-rate conversion ever happens on
this path. `SendDonateInputSchema` (social-transfers) and `PostGiftInputSchema`/
`PostRainInputSchema` (chat-commands, which the `GIFT_COMMANDS`/`RAIN_COMMANDS` ports carry
through as `SendGiftArgs.currency`/`SendRainArgs.currency`) all gain an optional `currency` ticker
field. Omitted, the transfer falls on the sender's active currency exactly as before - additive,
not breaking, for every existing caller.

Every recipient credit (gift claim, each rain recipient, donate) now passes
`allowNewCurrency: true`, so a recipient who has never held the sender's chosen currency still
receives it instead of failing `currency mismatch`. A sender naming a currency they do not hold
gets the same `insufficient_balance` failure as an over-spend.

Rain's per-recipient split now floors to the platform's own stored precision (`MONEY_SCALE`, 18
decimal places) instead of a hardcoded two-decimal ("cents") step, so an 18-decimal crypto amount
splits correctly instead of always flooring to zero and wrongly reporting `TooManyRecipientsError`.

Breaking:

- `chat_command_config.config`'s `maxAmount`/`minAmount` (`CommandConfigSchema`, chat-commands)
  change from a single flat `MoneyAmount` to `Record<currencyTicker, MoneyAmount>` - a limit
  sensible in one currency is not sensible in another, so one constant cannot cover every
  currency. A currency with no entry has no limit enforced for it. An operator with an existing
  flat `minAmount`/`maxAmount` row must re-save it keyed by currency (eg
  `{ minAmount: { USD: '1.00000000' } }`) via `PATCH /backoffice/chat-command/commands/{key}`; a
  legacy flat value is read as "no limit configured" rather than rejected.
