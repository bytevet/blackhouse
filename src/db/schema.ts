import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uuid,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// --- Better Auth managed tables ---

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  role: text("role").default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  username: text("username").unique(),
  displayUsername: text("display_username"),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// --- Application tables ---

export const sessionStatusEnum = pgEnum("session_status", [
  "pending",
  "running",
  "stopped",
  "destroyed",
]);

export const codingSessions = pgTable(
  "coding_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: sessionStatusEnum("status").notNull().default("pending"),
    gitRepoUrl: text("git_repo_url"),
    gitBranch: text("git_branch").default("main"),
    templateId: uuid("template_id").references(() => templates.id, {
      onDelete: "set null",
    }),
    preset: text("preset").notNull(),
    agentConfigId: text("agent_config_id"),
    containerId: text("container_id"),
    sessionToken: text("session_token"),
    containerImage: text("container_image").notNull(),
    resultHtml: text("result_html"),
    agentTitle: text("agent_title"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_sessions_user_id").on(table.userId),
    index("idx_sessions_status").on(table.status),
  ],
);

export const sessionMessages = pgTable(
  "session_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fromSessionId: uuid("from_session_id")
      .notNull()
      .references(() => codingSessions.id, { onDelete: "cascade" }),
    toSessionId: uuid("to_session_id")
      .notNull()
      .references(() => codingSessions.id, { onDelete: "cascade" }),
    message: text("message").notNull(),
    requestId: text("request_id"),
    // 'pending' | 'expired' — flat enum kept as text so reaper/cleanup
    // can add new states (e.g. 'cancelled') without a migration.
    status: text("status").notNull().default("pending"),
    // Stamped when a receiver first fetches the message via /inbox.
    // Observability only — does NOT flip status or ack_at.
    deliveredAt: timestamp("delivered_at"),
    // Stamped when the receiver acks. NULL = unread. At-least-once
    // delivery: acks are explicit (check-inbox.sh --ack or --ack-all),
    // never implicit. Handlers must be idempotent via request_id.
    ackAt: timestamp("ack_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Populated by the app at insert time: NOW() + 7 days. The reaper
    // (future) flips status='expired' when this passes.
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    // Fast-path for /inbox + /inbox/count: unread messages for a session.
    // Partial index keeps it small — only pending+unacked rows are indexed.
    index("idx_messages_inbox")
      .on(table.toSessionId, table.createdAt)
      .where(sql`status = 'pending' AND ack_at IS NULL`),
    // Dedup window: (from_session_id, request_id) within 60s returns the
    // existing message_id without re-inserting. Non-unique on purpose —
    // dedup is enforced in app code with a time window, not by the index.
    index("idx_messages_dedup").on(table.fromSessionId, table.requestId),
    // Reaper scan over non-expired rows.
    index("idx_messages_expires")
      .on(table.expiresAt)
      .where(sql`status != 'expired'`),
  ],
);

export const templates = pgTable(
  "templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    systemPrompt: text("system_prompt"),
    skills: jsonb("skills").$type<object[] | null>(),
    mcpConfig: jsonb("mcp_config").$type<object | null>(),
    volumeMounts: jsonb("volume_mounts").$type<{ name: string; mountPath: string }[] | null>(),
    isPublic: boolean("is_public").notNull().default(false),
    gitRequired: boolean("git_required").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_templates_user_id").on(table.userId),
    index("idx_templates_is_public").on(table.isPublic),
  ],
);

export const agentConfigs = pgTable("agent_configs", {
  id: uuid("id").defaultRandom().primaryKey(),
  preset: text("preset").notNull(),
  displayName: text("display_name").notNull(),
  agentCommand: text("agent_command"),
  envVars: jsonb("env_vars").$type<{ key: string; value: string }[] | null>(),
  volumeMounts: jsonb("volume_mounts").$type<{ name: string; mountPath: string }[] | null>(),
  dockerfileContent: text("dockerfile_content"),
  imageBuildStatus: text("image_build_status").notNull().default("none"),
  imageBuildLog: text("image_build_log"),
  lastBuiltAt: timestamp("last_built_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const dockerConfigs = pgTable("docker_configs", {
  id: integer("id").primaryKey().default(1),
  socketPath: text("socket_path").default("/var/run/docker.sock"),
  host: text("host"),
  port: integer("port"),
  tlsCa: text("tls_ca"),
  tlsCert: text("tls_cert"),
  tlsKey: text("tls_key"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// --- Inferred types ---

export type CodingSession = Omit<typeof codingSessions.$inferSelect, "resultHtml"> & {
  hasResult: boolean;
  unreadCount: number;
};
export type SessionMessage = typeof sessionMessages.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type AgentConfig = typeof agentConfigs.$inferSelect;
export type User = typeof user.$inferSelect;

export const SESSION_STATUSES = ["pending", "running", "stopped", "destroyed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type UserRole = "admin" | "user";

// --- Relations ---

export const userRelations = relations(user, ({ many }) => ({
  codingSessions: many(codingSessions),
  templates: many(templates),
}));

export const codingSessionsRelations = relations(codingSessions, ({ one }) => ({
  user: one(user, {
    fields: [codingSessions.userId],
    references: [user.id],
  }),
  template: one(templates, {
    fields: [codingSessions.templateId],
    references: [templates.id],
  }),
}));

export const templatesRelations = relations(templates, ({ one, many }) => ({
  user: one(user, {
    fields: [templates.userId],
    references: [user.id],
  }),
  codingSessions: many(codingSessions),
}));

export const sessionMessagesRelations = relations(sessionMessages, ({ one }) => ({
  fromSession: one(codingSessions, {
    fields: [sessionMessages.fromSessionId],
    references: [codingSessions.id],
    relationName: "messagesSent",
  }),
  toSession: one(codingSessions, {
    fields: [sessionMessages.toSessionId],
    references: [codingSessions.id],
    relationName: "messagesReceived",
  }),
}));
