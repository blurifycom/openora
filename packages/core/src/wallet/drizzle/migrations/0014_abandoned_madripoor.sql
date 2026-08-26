CREATE TYPE "public"."wallet_transaction_direction" AS ENUM('credit', 'debit');--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "direction" "wallet_transaction_direction";--> statement-breakpoint
-- Backfill direction from `type` only where it is unambiguous. gift/rain/tip write the
-- SAME type for both the sender's debit leg and the recipient's credit leg (see
-- engagement/social-transfers/service/social-transfers.service.ts), so a historical row
-- of one of those three types has no recoverable direction and is left NULL on purpose -
-- guessing would fabricate money-direction data that was never recorded.
UPDATE "wallet_transaction"
SET "direction" = CASE "type"
  WHEN 'deposit' THEN 'credit'
  WHEN 'win' THEN 'credit'
  WHEN 'bonus' THEN 'credit'
  WHEN 'manual_credit' THEN 'credit'
  WHEN 'withdrawal' THEN 'debit'
  WHEN 'bet' THEN 'debit'
  WHEN 'loss' THEN 'debit'
  WHEN 'manual_debit' THEN 'debit'
  ELSE NULL
END::"wallet_transaction_direction"
WHERE "direction" IS NULL;