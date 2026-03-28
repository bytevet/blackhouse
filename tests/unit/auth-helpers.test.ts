import { describe, it, expect, vi } from "vitest";

// Mock all heavy dependencies before importing
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    handler: (fn: unknown) => fn,
    inputValidator: () => ({
      handler: (fn: unknown) => fn,
    }),
  }),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => ({ headers: new Headers() }),
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  relations: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("@/db/schema", () => ({
  codingSessions: { id: "id" },
}));

import { requireAdmin } from "@/lib/auth-server";

describe("requireAdmin", () => {
  it("should be a function", () => {
    expect(typeof requireAdmin).toBe("function");
  });

  it("should throw for a user with role 'user'", () => {
    expect(() => requireAdmin({ user: { role: "user" } })).toThrow(
      "Forbidden: admin access required",
    );
  });

  it("should throw for a user with null role", () => {
    expect(() => requireAdmin({ user: { role: null } })).toThrow(
      "Forbidden: admin access required",
    );
  });

  it("should throw for a user with undefined role", () => {
    expect(() => requireAdmin({ user: { role: undefined } })).toThrow(
      "Forbidden: admin access required",
    );
  });

  it("should not throw for an admin user", () => {
    expect(() => requireAdmin({ user: { role: "admin" } })).not.toThrow();
  });

  it("should return undefined for an admin user", () => {
    const result = requireAdmin({ user: { role: "admin" } });
    expect(result).toBeUndefined();
  });
});
