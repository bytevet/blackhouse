CREATE TABLE "session_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_session_id" uuid NOT NULL,
	"to_session_id" uuid NOT NULL,
	"message" text NOT NULL,
	"request_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp,
	"ack_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_from_session_id_coding_sessions_id_fk" FOREIGN KEY ("from_session_id") REFERENCES "public"."coding_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_to_session_id_coding_sessions_id_fk" FOREIGN KEY ("to_session_id") REFERENCES "public"."coding_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_messages_inbox" ON "session_messages" USING btree ("to_session_id","created_at") WHERE status = 'pending' AND ack_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_messages_dedup" ON "session_messages" USING btree ("from_session_id","request_id");--> statement-breakpoint
CREATE INDEX "idx_messages_expires" ON "session_messages" USING btree ("expires_at") WHERE status != 'expired';