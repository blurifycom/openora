CREATE SEQUENCE "public"."event_outbox_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "seq" bigint;