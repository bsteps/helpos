ALTER TABLE "tenants" ADD COLUMN "shadow_mode" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "shadow_recipient" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_shadow_recipient_lowercase" CHECK ("tenants"."shadow_recipient" = lower("tenants"."shadow_recipient"));