ALTER TYPE "public"."promo_forfeit_reason" ADD VALUE 'cooling_off' BEFORE 'account_closed';--> statement-breakpoint
ALTER TYPE "public"."promo_forfeit_reason" ADD VALUE 'terms_breach';--> statement-breakpoint
ALTER TYPE "public"."promo_grant_source" ADD VALUE 'cashback';