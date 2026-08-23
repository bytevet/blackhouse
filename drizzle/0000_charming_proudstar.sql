-- Baseline for the multi-agent harness. This replaces migrations 0000..0005
-- of the session-centric schema, which are deleted rather than superseded:
-- the agreed migration path is "nuke everything, fresh DB, re-seed admin".
--
-- Hand-added preamble (drizzle-kit cannot know about tables that no longer
-- exist in the schema file). It fires ONLY when a legacy install is detected
-- via `coding_sessions`, so a genuinely empty database — the normal case —
-- skips it entirely. When it does fire it drops the auth tables too: the
-- baseline below recreates them unconditionally, and a half-dropped legacy
-- database that boots is precisely the failure mode this cutover must not
-- produce. `server/db/seed.ts` restores the admin account afterwards.
DO $$
BEGIN
	IF to_regclass('public.coding_sessions') IS NOT NULL THEN
		RAISE NOTICE 'blackhouse: legacy session-centric schema detected — dropping it for the multi-agent baseline';
		DROP TABLE IF EXISTS "session_messages" CASCADE;
		DROP TABLE IF EXISTS "coding_sessions" CASCADE;
		DROP TABLE IF EXISTS "templates" CASCADE;
		DROP TABLE IF EXISTS "agent_configs" CASCADE;
		DROP TABLE IF EXISTS "docker_configs" CASCADE;
		DROP TABLE IF EXISTS "verification" CASCADE;
		DROP TABLE IF EXISTS "account" CASCADE;
		DROP TABLE IF EXISTS "session" CASCADE;
		DROP TABLE IF EXISTS "user" CASCADE;
		DROP TYPE IF EXISTS "public"."session_status";
	END IF;
END $$;--> statement-breakpoint
CREATE TYPE "public"."agent_activity" AS ENUM('idle', 'busy', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."agent_cli" AS ENUM('claude-code', 'codex', 'antigravity', 'custom');--> statement-breakpoint
CREATE TYPE "public"."agent_event_type" AS ENUM('turn_start', 'assistant_text', 'tool_use', 'tool_result', 'turn_end', 'status', 'usage', 'raw');--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('creating', 'running', 'stopped', 'error', 'destroyed');--> statement-breakpoint
CREATE TYPE "public"."artifact_kind" AS ENUM('html', 'file', 'link', 'text');--> statement-breakpoint
CREATE TYPE "public"."channel_member_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."dispatch_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "public"."egress_policy" AS ENUM('none', 'allowlist', 'open');--> statement-breakpoint
CREATE TYPE "public"."egress_scope" AS ENUM('workspace', 'blueprint', 'agent');--> statement-breakpoint
CREATE TYPE "public"."injection_mode" AS ENUM('queue', 'interrupt');--> statement-breakpoint
CREATE TYPE "public"."message_author_kind" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text', 'event', 'artifact', 'dispatch_request', 'system');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'injecting', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sandbox_runtime" AS ENUM('auto', 'runc', 'runsc', 'kata');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_blueprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cli" "agent_cli" DEFAULT 'custom' NOT NULL,
	"agent_command" text,
	"image" text,
	"dockerfile_content" text,
	"image_build_status" text DEFAULT 'none' NOT NULL,
	"image_build_log" text,
	"last_built_at" timestamp,
	"system_prompt" text,
	"skills" jsonb,
	"mcp_config" jsonb,
	"env_vars" jsonb,
	"volume_mounts" jsonb,
	"state_mount_path" text,
	"sandbox_runtime" "sandbox_runtime" DEFAULT 'auto' NOT NULL,
	"egress_policy" "egress_policy" DEFAULT 'allowlist' NOT NULL,
	"egress_allowlist" jsonb,
	"memory_bytes" bigint,
	"nano_cpus" bigint,
	"pids_limit" integer,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_blueprints_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"seq" bigint NOT NULL,
	"source_ref" text NOT NULL,
	"type" "agent_event_type" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"blueprint_id" uuid NOT NULL,
	"owner_id" text,
	"status" "agent_status" DEFAULT 'creating' NOT NULL,
	"activity" "agent_activity" DEFAULT 'unknown' NOT NULL,
	"activity_updated_at" timestamp,
	"container_id" text,
	"container_image" text,
	"sandbox_runtime" "sandbox_runtime",
	"runtime_used" text,
	"egress_policy" "egress_policy",
	"agent_token" text,
	"workspace_volume" text NOT NULL,
	"state_volume" text NOT NULL,
	"git_repo_url" text,
	"git_branch" text DEFAULT 'main',
	"status_line" text,
	"system_prompt_override" text,
	"daily_budget_cents" integer,
	"spent_cents_today" integer DEFAULT 0 NOT NULL,
	"budget_window_start" timestamp DEFAULT now() NOT NULL,
	"paused_at" timestamp,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agents_agent_token_unique" UNIQUE("agent_token")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"message_id" uuid,
	"agent_id" uuid,
	"run_id" uuid,
	"created_by_user_id" text,
	"kind" "artifact_kind" DEFAULT 'html' NOT NULL,
	"title" text,
	"content_type" text,
	"body" text,
	"url" text,
	"size_bytes" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"agent_id" uuid,
	"user_id" text,
	"role" "channel_member_role" DEFAULT 'member' NOT NULL,
	"last_read_at" timestamp,
	"cursor_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "channel_members_exactly_one_subject" CHECK (("channel_members"."agent_id" IS NOT NULL)::int + ("channel_members"."user_id" IS NOT NULL)::int = 1)
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"topic" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"git_repo_url" text,
	"git_branch" text,
	"auto_approve_dispatch" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "channels_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "dispatch_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"from_agent_id" uuid NOT NULL,
	"to_agent_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"approved_prompt" text,
	"status" "dispatch_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"message_id" uuid,
	"created_run_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docker_configs" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"socket_path" text DEFAULT '/var/run/docker.sock',
	"host" text,
	"port" integer,
	"tls_ca" text,
	"tls_cert" text,
	"tls_key" text,
	"default_sandbox_driver" "sandbox_runtime" DEFAULT 'auto' NOT NULL,
	"detected_runtimes" jsonb,
	"runtime_probed_at" timestamp,
	"egress_enforce" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "egress_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host" text NOT NULL,
	"scope" "egress_scope" DEFAULT 'workspace' NOT NULL,
	"blueprint_id" uuid,
	"agent_id" uuid,
	"added_by_user_id" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "egress_rules_scope_target" CHECK ((
        ("egress_rules"."scope" = 'workspace' AND "egress_rules"."blueprint_id" IS NULL AND "egress_rules"."agent_id" IS NULL)
        OR ("egress_rules"."scope" = 'blueprint' AND "egress_rules"."blueprint_id" IS NOT NULL AND "egress_rules"."agent_id" IS NULL)
        OR ("egress_rules"."scope" = 'agent' AND "egress_rules"."agent_id" IS NOT NULL AND "egress_rules"."blueprint_id" IS NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "message_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"channel_id" uuid NOT NULL,
	"parent_id" uuid,
	"author_kind" "message_author_kind" NOT NULL,
	"author_user_id" text,
	"author_agent_id" uuid,
	"kind" "message_kind" DEFAULT 'text' NOT NULL,
	"body" text,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"request_id" text,
	"run_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid,
	"trigger_message_id" uuid,
	"requester_user_id" text,
	"requester_agent_id" uuid,
	"prompt" text NOT NULL,
	"injection_mode" "injection_mode" DEFAULT 'queue' NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"queued_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"name" text,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"prompt" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp,
	"last_run_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text DEFAULT 'user',
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	"username" text,
	"display_username" text,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_blueprints" ADD CONSTRAINT "agent_blueprints_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_blueprint_id_agent_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."agent_blueprints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD CONSTRAINT "dispatch_requests_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD CONSTRAINT "dispatch_requests_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD CONSTRAINT "dispatch_requests_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD CONSTRAINT "dispatch_requests_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD CONSTRAINT "dispatch_requests_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_requests" ADD CONSTRAINT "dispatch_requests_created_run_id_runs_id_fk" FOREIGN KEY ("created_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_rules" ADD CONSTRAINT "egress_rules_blueprint_id_agent_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."agent_blueprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_rules" ADD CONSTRAINT "egress_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_rules" ADD CONSTRAINT "egress_rules_added_by_user_id_user_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_id_messages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_requester_user_id_user_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_requester_agent_id_agents_id_fk" FOREIGN KEY ("requester_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_blueprints_created_by" ON "agent_blueprints" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_blueprints_is_public" ON "agent_blueprints" USING btree ("is_public");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_events_source" ON "agent_events" USING btree ("agent_id","source_ref");--> statement-breakpoint
CREATE INDEX "idx_agent_events_run_seq" ON "agent_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "idx_agent_events_agent_seq" ON "agent_events" USING btree ("agent_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agents_handle_lower" ON "agents" USING btree (lower("handle"));--> statement-breakpoint
CREATE INDEX "idx_agents_status" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_agents_owner_id" ON "agents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_agents_blueprint_id" ON "agents" USING btree ("blueprint_id");--> statement-breakpoint
CREATE INDEX "idx_agents_container_id" ON "agents" USING btree ("container_id") WHERE container_id IS NOT NULL AND status <> 'destroyed';--> statement-breakpoint
CREATE INDEX "idx_artifacts_channel_created" ON "artifacts" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_artifacts_agent" ON "artifacts" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_message" ON "artifacts" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_channel_members_user" ON "channel_members" USING btree ("channel_id","user_id") WHERE user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_channel_members_agent" ON "channel_members" USING btree ("channel_id","agent_id") WHERE agent_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_channel_members_agent" ON "channel_members" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_channel_members_user" ON "channel_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_channels_active" ON "channels" USING btree ("name") WHERE is_archived = false;--> statement-breakpoint
CREATE INDEX "idx_dispatch_pending_expiry" ON "dispatch_requests" USING btree ("expires_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_dispatch_channel_created" ON "dispatch_requests" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_dispatch_to_agent" ON "dispatch_requests" USING btree ("to_agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_egress_rules_workspace_host" ON "egress_rules" USING btree ("host") WHERE scope = 'workspace';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_egress_rules_blueprint_host" ON "egress_rules" USING btree ("blueprint_id","host") WHERE scope = 'blueprint';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_egress_rules_agent_host" ON "egress_rules" USING btree ("agent_id","host") WHERE scope = 'agent';--> statement-breakpoint
CREATE INDEX "idx_egress_rules_scope" ON "egress_rules" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_message_mentions" ON "message_mentions" USING btree ("message_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_message_mentions_agent" ON "message_mentions" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_messages_channel_seq" ON "messages" USING btree ("channel_id","seq");--> statement-breakpoint
CREATE INDEX "idx_messages_channel_created" ON "messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_messages_mentions" ON "messages" USING gin ("mentions");--> statement-breakpoint
CREATE INDEX "idx_messages_dedup" ON "messages" USING btree ("author_agent_id","request_id") WHERE request_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_messages_run_id" ON "messages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_messages_parent_id" ON "messages" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_runs_queued" ON "runs" USING btree ("agent_id","queued_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "idx_runs_agent_created" ON "runs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runs_channel_created" ON "runs" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runs_status" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_schedules_due" ON "schedules" USING btree ("next_run_at") WHERE enabled = true;--> statement-breakpoint
CREATE INDEX "idx_schedules_agent" ON "schedules" USING btree ("agent_id");