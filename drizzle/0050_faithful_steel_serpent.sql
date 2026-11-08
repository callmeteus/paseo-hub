ALTER TABLE "trigger_runs" DROP CONSTRAINT "trigger_runs_deadline_shape_check";--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD CONSTRAINT "trigger_runs_deadline_shape_check" CHECK (("trigger_runs"."outcome" = 'accepted')
        or ("trigger_runs"."outcome" = 'rejected' and "trigger_runs"."deadline_at" is null));