ALTER TABLE "templates" ADD COLUMN "volume_mounts" jsonb;--> statement-breakpoint
CREATE INDEX "idx_sessions_user_id" ON "coding_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_status" ON "coding_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_templates_user_id" ON "templates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_templates_is_public" ON "templates" USING btree ("is_public");