CREATE TABLE "telegram_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"provider_application_id" text,
	"slug" text NOT NULL,
	"chat_name" text NOT NULL,
	"connected_by_user_id" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_connections_chat_id_unique" UNIQUE("chat_id")
);
--> statement-breakpoint
ALTER TABLE "provider_event_receipts" DROP CONSTRAINT "provider_event_receipts_provider_check";--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_provider_check" CHECK ("provider" in ('github', 'slack', 'discord', 'linear', 'telegram', 'manual', 'schedule'));
--> statement-breakpoint
ALTER TABLE "project_trigger_routes" DROP CONSTRAINT "project_trigger_routes_provider_check";--> statement-breakpoint
ALTER TABLE "project_trigger_routes" ADD CONSTRAINT "project_trigger_routes_provider_check" CHECK ("provider" in ('github', 'slack', 'discord', 'linear', 'telegram'));
--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" DROP CONSTRAINT "runtime_provider_activation_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" ADD CONSTRAINT "runtime_provider_activation_provider_check" CHECK ("provider" in ('github', 'slack', 'discord', 'linear', 'telegram'));
--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" DROP CONSTRAINT "runtime_provider_configuration_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" ADD CONSTRAINT "runtime_provider_configuration_provider_check" CHECK ("provider" in ('github', 'slack', 'discord', 'linear', 'telegram'));
