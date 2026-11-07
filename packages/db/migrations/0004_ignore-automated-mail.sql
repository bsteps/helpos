ALTER TABLE "messages" ADD COLUMN "automated_reason" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "automated" boolean DEFAULT false NOT NULL;