DROP INDEX "kyc_verification_reference_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_verification_reference_id_key" ON "kyc_verification" USING btree ("reference_id");