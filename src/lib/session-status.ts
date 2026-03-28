import type { SessionStatus } from "@/db/schema";

export const sessionStatusConfig: Record<SessionStatus, { className: string; label: string }> = {
  running: {
    className: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400",
    label: "Running",
  },
  stopped: {
    className: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
    label: "Stopped",
  },
  pending: {
    className: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
    label: "Pending",
  },
  destroyed: {
    className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
    label: "Destroyed",
  },
};
