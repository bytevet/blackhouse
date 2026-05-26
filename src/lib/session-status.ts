import type { SessionStatus } from "@/db/schema";

type LabelKey = "status.onDuty" | "status.offDuty" | "status.pending" | "status.terminated";
type WorkerLabelKey =
  | "status.workerOnDuty"
  | "status.workerOffDuty"
  | "status.workerPending"
  | "status.workerTerminated";

interface SessionStatusEntry {
  /** Badge classes — border + bg + fg for the existing `<Badge>` usage. */
  className: string;
  /** Background+foreground for the worker-card status band (#51). No border. */
  bandClassName: string;
  /** i18n key for the conventional label ("On duty", "Off duty", …).
   *  Consumers resolve via `useTranslation().t()`. (#55) */
  labelKey: LabelKey;
  /** i18n key for the worker-card all-caps chip label
   *  ("ON DUTY", "OFF DUTY", …). (#55) */
  workerLabelKey: WorkerLabelKey;
}

export const sessionStatusConfig: Record<SessionStatus, SessionStatusEntry> = {
  running: {
    className: "border-success/30 bg-success-bg text-success-fg",
    bandClassName: "bg-success-bg text-success-fg",
    labelKey: "status.onDuty",
    workerLabelKey: "status.workerOnDuty",
  },
  stopped: {
    className: "border-warning/30 bg-warning-bg text-warning-fg",
    bandClassName: "bg-warning-bg text-warning-fg",
    labelKey: "status.offDuty",
    workerLabelKey: "status.workerOffDuty",
  },
  pending: {
    className: "border-info/30 bg-info-bg text-info-fg",
    bandClassName: "bg-info-bg text-info-fg",
    labelKey: "status.pending",
    workerLabelKey: "status.workerPending",
  },
  destroyed: {
    className: "border-error/30 bg-error-bg text-error-fg",
    bandClassName: "bg-error-bg text-error-fg",
    labelKey: "status.terminated",
    workerLabelKey: "status.workerTerminated",
  },
};
