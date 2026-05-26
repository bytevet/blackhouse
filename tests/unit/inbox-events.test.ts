import { describe, it, expect, vi } from "vitest";
import { inboxEvents } from "../../server/lib/inbox-events.js";

describe("inboxEvents bus", () => {
  it("delivers events to a single subscriber", () => {
    const seen: unknown[] = [];
    const unsub = inboxEvents.subscribe("u1", (ev) => seen.push(ev));
    inboxEvents.emit("u1", { type: "unread-changed", sessionId: "s1", unreadCount: 3 });
    expect(seen).toEqual([{ type: "unread-changed", sessionId: "s1", unreadCount: 3 }]);
    unsub();
  });

  it("fans out to multiple subscribers for the same user", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = inboxEvents.subscribe("u2", a);
    const unsubB = inboxEvents.subscribe("u2", b);
    inboxEvents.emit("u2", { type: "unread-changed", sessionId: "s2", unreadCount: 1 });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    unsubA();
    unsubB();
  });

  it("isolates events by user id", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = inboxEvents.subscribe("u3", a);
    const unsubB = inboxEvents.subscribe("u4", b);
    inboxEvents.emit("u3", { type: "unread-changed", sessionId: "s3", unreadCount: 1 });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    unsubA();
    unsubB();
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const unsub = inboxEvents.subscribe("u5", listener);
    unsub();
    inboxEvents.emit("u5", { type: "unread-changed", sessionId: "s5", unreadCount: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("no-ops emit to a user with no subscribers", () => {
    expect(() =>
      inboxEvents.emit("u-never-subscribed", {
        type: "unread-changed",
        sessionId: "sx",
        unreadCount: 0,
      }),
    ).not.toThrow();
  });
});
