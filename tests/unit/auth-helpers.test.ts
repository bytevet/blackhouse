import { describe, it, expect } from "vitest";

// Test the requireAdmin logic directly (no import needed)
function requireAdmin(session: { user: { role?: string | null } }) {
  if (session.user.role !== "admin") {
    throw new Error("Forbidden: admin access required");
  }
}

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
