CREATE TABLE "automation_git_sync" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"github_connection_id" uuid,
	"repository_id" bigint,
	"repository_full_name" text,
	"branch" text,
	"automations_directory" text,
	"interval_minutes" integer DEFAULT 15 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_commit_sha" text,
	"last_status" text,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "organization_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"statement" text NOT NULL,
	"replies" jsonb NOT NULL,
	"tool_name" text NOT NULL,
	"tool_result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_git_sync" ADD CONSTRAINT "automation_git_sync_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_findings" ADD CONSTRAINT "organization_findings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_findings_organization_idx" ON "organization_findings" USING btree ("organization_id","created_at");