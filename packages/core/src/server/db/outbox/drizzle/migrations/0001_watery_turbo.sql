CREATE TABLE "openora_instance" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"instance_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openora_instance_singleton" CHECK ("openora_instance"."singleton")
);
