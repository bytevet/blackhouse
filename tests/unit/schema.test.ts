import { describe, it, expect } from "vitest";
import {
  user,
  session,
  account,
  verification,
  codingSessions,
  templates,
  agentConfigs,
  dockerConfigs,
  sessionStatusEnum,
  SESSION_STATUSES,
  userRelations,
  codingSessionsRelations,
  templatesRelations,
} from "@/db/schema";
import type {
  CodingSession,
  Template,
  AgentConfig,
  User,
  SessionStatus,
  UserRole,
} from "@/db/schema";

describe("Database Schema", () => {
  describe("sessionStatusEnum", () => {
    it("should have exactly four status values", () => {
      expect(sessionStatusEnum.enumValues).toHaveLength(4);
    });

    it("should contain the correct status values", () => {
      expect(sessionStatusEnum.enumValues).toEqual(["pending", "running", "stopped", "destroyed"]);
    });
  });

  describe("SESSION_STATUSES constant", () => {
    it("should match the enum values", () => {
      expect([...SESSION_STATUSES]).toEqual(sessionStatusEnum.enumValues);
    });
  });

  describe("Better Auth tables", () => {
    it("should define user table with required columns", () => {
      const columns = Object.keys(user);
      expect(columns).toContain("id");
      expect(columns).toContain("name");
      expect(columns).toContain("email");
      expect(columns).toContain("emailVerified");
      expect(columns).toContain("role");
      expect(columns).toContain("createdAt");
      expect(columns).toContain("updatedAt");
    });

    it("should define session table with required columns", () => {
      const columns = Object.keys(session);
      expect(columns).toContain("id");
      expect(columns).toContain("expiresAt");
      expect(columns).toContain("token");
      expect(columns).toContain("userId");
    });

    it("should define account table with required columns", () => {
      const columns = Object.keys(account);
      expect(columns).toContain("id");
      expect(columns).toContain("accountId");
      expect(columns).toContain("providerId");
      expect(columns).toContain("userId");
    });

    it("should define verification table with required columns", () => {
      const columns = Object.keys(verification);
      expect(columns).toContain("id");
      expect(columns).toContain("identifier");
      expect(columns).toContain("value");
      expect(columns).toContain("expiresAt");
    });
  });

  describe("Application tables", () => {
    it("should define codingSessions table with all columns", () => {
      const columns = Object.keys(codingSessions);
      expect(columns).toContain("id");
      expect(columns).toContain("userId");
      expect(columns).toContain("name");
      expect(columns).toContain("status");
      expect(columns).toContain("gitRepoUrl");
      expect(columns).toContain("gitBranch");
      expect(columns).toContain("templateId");
      expect(columns).toContain("agentType");
      expect(columns).toContain("containerId");
      expect(columns).toContain("containerImage");
      expect(columns).toContain("resultHtml");
      expect(columns).toContain("createdAt");
      expect(columns).toContain("updatedAt");
    });

    it("should define templates table with all columns", () => {
      const columns = Object.keys(templates);
      expect(columns).toContain("id");
      expect(columns).toContain("userId");
      expect(columns).toContain("name");
      expect(columns).toContain("description");
      expect(columns).toContain("systemPrompt");
      expect(columns).toContain("skills");
      expect(columns).toContain("mcpConfig");
      expect(columns).toContain("isPublic");
      expect(columns).toContain("createdAt");
      expect(columns).toContain("updatedAt");
    });

    it("should define agentConfigs table with all columns", () => {
      const columns = Object.keys(agentConfigs);
      expect(columns).toContain("id");
      expect(columns).toContain("agentType");
      expect(columns).toContain("displayName");
      expect(columns).toContain("apiKeyEncrypted");
      expect(columns).toContain("yoloMode");
      expect(columns).toContain("defaultModel");
      expect(columns).toContain("extraArgs");
      expect(columns).toContain("dockerImage");
      expect(columns).toContain("createdAt");
      expect(columns).toContain("updatedAt");
    });

    it("should define dockerConfigs table with all columns", () => {
      const columns = Object.keys(dockerConfigs);
      expect(columns).toContain("id");
      expect(columns).toContain("socketPath");
      expect(columns).toContain("host");
      expect(columns).toContain("port");
      expect(columns).toContain("tlsCa");
      expect(columns).toContain("tlsCert");
      expect(columns).toContain("tlsKey");
      expect(columns).toContain("updatedAt");
    });
  });

  describe("Relations", () => {
    it("should export userRelations", () => {
      expect(userRelations).toBeDefined();
    });

    it("should export codingSessionsRelations", () => {
      expect(codingSessionsRelations).toBeDefined();
    });

    it("should export templatesRelations", () => {
      expect(templatesRelations).toBeDefined();
    });
  });

  describe("Exported types", () => {
    it("should allow constructing a CodingSession-shaped object", () => {
      const cs: CodingSession = {
        id: "test-uuid",
        userId: "user-1",
        name: "Test Session",
        status: "running",
        gitRepoUrl: null,
        gitBranch: "main",
        templateId: null,
        agentType: "claude",
        containerId: null,
        containerImage: "ubuntu:latest",
        resultHtml: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(cs.name).toBe("Test Session");
    });

    it("should allow constructing a Template-shaped object", () => {
      const t: Template = {
        id: "tpl-uuid",
        userId: "user-1",
        name: "My Template",
        description: null,
        systemPrompt: null,
        skills: null,
        mcpConfig: null,
        isPublic: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(t.name).toBe("My Template");
    });

    it("should allow constructing an AgentConfig-shaped object", () => {
      const ac: AgentConfig = {
        id: "ac-uuid",
        agentType: "claude",
        displayName: "Claude Code",
        apiKeyEncrypted: null,
        yoloMode: true,
        defaultModel: null,
        extraArgs: null,
        dockerImage: "ubuntu:latest",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(ac.agentType).toBe("claude");
    });

    it("should allow constructing a User-shaped object", () => {
      const u: User = {
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
        emailVerified: false,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        role: "user",
        banned: false,
        banReason: null,
        banExpires: null,
        username: null,
        displayUsername: null,
      };
      expect(u.email).toBe("test@example.com");
    });

    it("should enforce SessionStatus as a union of valid statuses", () => {
      const statuses: SessionStatus[] = ["pending", "running", "stopped", "destroyed"];
      expect(statuses).toHaveLength(4);
    });

    it("should enforce UserRole as admin or user", () => {
      const roles: UserRole[] = ["admin", "user"];
      expect(roles).toHaveLength(2);
    });
  });
});
