-- Hand-written: Postgres keeps a renamed table's old constraint and index names, so each is
-- renamed too.
ALTER TABLE "tickets" RENAME TO "conversations";--> statement-breakpoint
ALTER TABLE "conversations" RENAME CONSTRAINT "tickets_pkey" TO "conversations_pkey";--> statement-breakpoint
ALTER TABLE "conversations" RENAME CONSTRAINT "tickets_tenant_id_id" TO "conversations_tenant_id_id";--> statement-breakpoint
ALTER TABLE "conversations" RENAME CONSTRAINT "tickets_tenant_id_tenants_id_fk" TO "conversations_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" RENAME CONSTRAINT "tickets_customer_fk" TO "conversations_customer_fk";--> statement-breakpoint
ALTER TABLE "conversations" RENAME CONSTRAINT "tickets_mailbox_fk" TO "conversations_mailbox_fk";--> statement-breakpoint
ALTER TABLE "conversations" RENAME CONSTRAINT "tickets_status" TO "conversations_status";--> statement-breakpoint
ALTER TABLE "conversations" RENAME CONSTRAINT "tickets_ai_paused_reason" TO "conversations_ai_paused_reason";--> statement-breakpoint
ALTER INDEX "tickets_tenant_last_message" RENAME TO "conversations_tenant_last_message";--> statement-breakpoint
ALTER INDEX "tickets_tenant_status_last_message" RENAME TO "conversations_tenant_status_last_message";--> statement-breakpoint
ALTER TABLE "messages" RENAME COLUMN "ticket_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "messages" RENAME CONSTRAINT "messages_ticket_fk" TO "messages_conversation_fk";--> statement-breakpoint
ALTER INDEX "messages_tenant_ticket" RENAME TO "messages_tenant_conversation";--> statement-breakpoint
ALTER TABLE "drafts" RENAME COLUMN "ticket_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "drafts" RENAME CONSTRAINT "drafts_ticket_fk" TO "drafts_conversation_fk";--> statement-breakpoint
ALTER INDEX "drafts_tenant_ticket" RENAME TO "drafts_tenant_conversation";--> statement-breakpoint
ALTER TABLE "ticket_github_issues" RENAME TO "conversation_github_issues";--> statement-breakpoint
ALTER TABLE "conversation_github_issues" RENAME COLUMN "ticket_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "conversation_github_issues" RENAME CONSTRAINT "ticket_github_issues_pkey" TO "conversation_github_issues_pkey";--> statement-breakpoint
ALTER TABLE "conversation_github_issues" RENAME CONSTRAINT "ticket_github_issues_tenant_id_tenants_id_fk" TO "conversation_github_issues_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "conversation_github_issues" RENAME CONSTRAINT "ticket_github_issues_ticket_fk" TO "conversation_github_issues_conversation_fk";--> statement-breakpoint
ALTER TABLE "conversation_github_issues" RENAME CONSTRAINT "ticket_github_issues_tenant_ticket" TO "conversation_github_issues_tenant_conversation";--> statement-breakpoint
ALTER TABLE "conversation_github_issues" RENAME CONSTRAINT "ticket_github_issues_state" TO "conversation_github_issues_state";--> statement-breakpoint
ALTER TABLE "conversation_github_issues" RENAME CONSTRAINT "ticket_github_issues_created" TO "conversation_github_issues_created";--> statement-breakpoint
ALTER TABLE "conversation_github_issues" RENAME CONSTRAINT "ticket_github_issues_repo_lowercase" TO "conversation_github_issues_repo_lowercase";--> statement-breakpoint
ALTER INDEX "ticket_github_issues_tenant_issue" RENAME TO "conversation_github_issues_tenant_issue";
