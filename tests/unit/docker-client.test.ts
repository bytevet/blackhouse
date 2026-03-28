import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInstance = { ping: vi.fn() };

vi.mock("dockerode", () => {
  return {
    default: class MockDocker {
      constructor() {
        return mockInstance;
      }
    },
  };
});

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  dockerConfigs: {},
}));

import { getDockerClient, resetDockerClient } from "@/lib/docker";

describe("Docker Client", () => {
  beforeEach(() => {
    resetDockerClient();
  });

  describe("getDockerClient", () => {
    it("should return a Docker instance", async () => {
      const client = await getDockerClient();
      expect(client).toBeDefined();
    });

    it("should cache the Docker client on subsequent calls", async () => {
      const client1 = await getDockerClient();
      const client2 = await getDockerClient();
      expect(client1).toBe(client2);
    });
  });

  describe("resetDockerClient", () => {
    it("should be callable multiple times without error", () => {
      expect(() => {
        resetDockerClient();
        resetDockerClient();
        resetDockerClient();
      }).not.toThrow();
    });
  });
});
