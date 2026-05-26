import { EventEmitter } from "node:events";

/**
 * Per-user event bus for inbox/unread-count changes.
 *
 * Each user gets a single Node EventEmitter on first subscribe; every
 * dashboard tab open by that user attaches a listener to the same
 * emitter. Emit-time fan-out: O(active-tabs-for-this-user), all
 * synchronous, no DB.
 *
 * Single-instance only — sufficient for the current Blackhouse deploy
 * model. If we ever go multi-replica, swap the per-user EventEmitter
 * for a Postgres LISTEN/NOTIFY channel.
 *
 * The emitter is kept alive after the last listener leaves (cheap, ~100
 * bytes per registered user) so a reconnecting tab doesn't miss events
 * during the ~100 ms gap.
 */

export type InboxEvent = {
  type: "unread-changed";
  sessionId: string;
  unreadCount: number;
};

type Listener = (ev: InboxEvent) => void;

class InboxEventBus {
  private emitters = new Map<string, EventEmitter>();

  private getOrCreate(userId: string): EventEmitter {
    let ee = this.emitters.get(userId);
    if (!ee) {
      ee = new EventEmitter();
      // Bounded: each tab adds one listener; 50 tabs per user is far
      // beyond realistic usage. Suppress Node's default warning at 10.
      ee.setMaxListeners(50);
      this.emitters.set(userId, ee);
    }
    return ee;
  }

  /** Subscribe; returns the unsubscribe fn. */
  subscribe(userId: string, listener: Listener): () => void {
    const ee = this.getOrCreate(userId);
    ee.on("event", listener);
    return () => ee.off("event", listener);
  }

  /** Emit to all active listeners for the user. No-op if none. */
  emit(userId: string, ev: InboxEvent): void {
    const ee = this.emitters.get(userId);
    if (!ee) return;
    ee.emit("event", ev);
  }
}

export const inboxEvents = new InboxEventBus();
