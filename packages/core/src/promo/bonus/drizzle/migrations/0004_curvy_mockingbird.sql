ALTER TABLE "promo_grant_entry" DROP CONSTRAINT "promo_grant_entry_grant_id_promo_grant_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "promo_grant_id_user_id_currency_idx" ON "promo_grant" USING btree ("id","user_id","currency");
--> statement-breakpoint
ALTER TABLE "promo_grant_entry" ADD CONSTRAINT "promo_grant_entry_grant_id_user_id_currency_promo_grant_id_user_id_currency_fk" FOREIGN KEY ("grant_id","user_id","currency") REFERENCES "public"."promo_grant"("id","user_id","currency") ON DELETE restrict ON UPDATE no action;