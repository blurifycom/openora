-- Non-destructive in-place relabel: 'fireblocks' was the crypto rail, 'psp' the fiat
-- rail. RENAME VALUE preserves existing rows (a DROP/recreate would fail the cast).
ALTER TYPE "public"."wallet_rail" RENAME VALUE 'fireblocks' TO 'crypto';--> statement-breakpoint
ALTER TYPE "public"."wallet_rail" RENAME VALUE 'psp' TO 'fiat';
