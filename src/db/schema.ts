import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uuid,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

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

export const codingSessions = pgTable("coding_sessions", {
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
  agentType: text("agent_type").notNull(),
  containerId: text("container_id"),
  containerImage: text("container_image").notNull(),
  resultHtml: text("result_html"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const templates = pgTable("templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  systemPrompt: text("system_prompt"),
  skills: jsonb("skills"),
  mcpConfig: jsonb("mcp_config"),
  isPublic: boolean("is_public").notNull().default(false),
  yoloMode: boolean("yolo_mode").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const agentConfigs = pgTable("agent_configs", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentType: text("agent_type").notNull().unique(),
  displayName: text("display_name").notNull(),
  apiKeyEncrypted: text("api_key_encrypted"),
  defaultModel: text("default_model"),
  extraArgs: jsonb("extra_args"),
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

export type CodingSession = typeof codingSessions.$inferSelect;
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
