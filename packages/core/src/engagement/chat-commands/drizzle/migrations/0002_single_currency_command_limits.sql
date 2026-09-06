-- `minAmount`/`maxAmount` moved from a per-currency map (and, before that, a flat amount
-- string) to a single `{currency, amount}` pair: the limit is now stated once and every
-- other currency is converted into it at check time, the way a responsible-gambling limit
-- already behaves. Rows written under either older shape fail the output schema, so the
-- whole command list 500s until they are rewritten.
--
-- A flat string carries no currency of its own; USD is the currency the seed used when that
-- shape was written, and no other record of it exists. A map keeps its USD entry when it has
-- one, otherwise its alphabetically first key, so the result is the same on every stand.
-- Rows already carrying a `currency` key are skipped, which keeps this re-runnable.
UPDATE "chat_command_config"
SET "config" = "config" || jsonb_build_object('minAmount',
  CASE jsonb_typeof("config"->'minAmount')
    WHEN 'string' THEN jsonb_build_object('currency', 'USD', 'amount', "config"->>'minAmount')
    ELSE (
      SELECT jsonb_build_object('currency', entry.key, 'amount', entry.value)
      FROM jsonb_each_text("config"->'minAmount') AS entry
      ORDER BY (entry.key <> 'USD'), entry.key
      LIMIT 1
    )
  END)
WHERE jsonb_typeof("config"->'minAmount') = 'string'
   OR (
     jsonb_typeof("config"->'minAmount') = 'object'
     AND "config"->'minAmount' <> '{}'::jsonb
     AND NOT jsonb_exists("config"->'minAmount', 'currency')
   );
--> statement-breakpoint
UPDATE "chat_command_config"
SET "config" = "config" || jsonb_build_object('maxAmount',
  CASE jsonb_typeof("config"->'maxAmount')
    WHEN 'string' THEN jsonb_build_object('currency', 'USD', 'amount', "config"->>'maxAmount')
    ELSE (
      SELECT jsonb_build_object('currency', entry.key, 'amount', entry.value)
      FROM jsonb_each_text("config"->'maxAmount') AS entry
      ORDER BY (entry.key <> 'USD'), entry.key
      LIMIT 1
    )
  END)
WHERE jsonb_typeof("config"->'maxAmount') = 'string'
   OR (
     jsonb_typeof("config"->'maxAmount') = 'object'
     AND "config"->'maxAmount' <> '{}'::jsonb
     AND NOT jsonb_exists("config"->'maxAmount', 'currency')
   );
