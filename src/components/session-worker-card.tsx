import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Bot, Clock, Eye, GitBranch, RotateCcw, Square, User, UserX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { codename } from "@/lib/codename";
import { avatarUrl } from "@/lib/avatar";
import { sessionStatusConfig } from "@/lib/session-status";
import type { CodingSession, SessionStatus } from "@/db/schema";

export type SessionForCard = CodingSession & {
  user?: { name: string | null; email: string | null };
};

// Shared classes for the bottom action-bar buttons: equal width via flex-1,
// auto height so the icon-over-label stack can size to content, vertical
// stacking with a small gap, and a tiny label so 3 buttons fit at the
// narrowest card width (220px) without truncation.
const actionButtonClass =
  "flex-1 h-auto flex-col gap-0.5 px-1 py-1.5 text-[0.625rem] font-normal [&_svg]:size-4";

interface SessionWorkerCardProps {
  session: SessionForCard;
  /** When true, show the owning user line (admin view of all sessions). */
  showOwner?: boolean;
  /** "Stop" / "Dismiss" / "Re-spawn" launchers — kept in the parent so the
   *  confirm dialog can live there too. */
  onStop?: (id: string, name: string) => void;
  onDestroy?: (id: string, name: string) => void;
  onRecreate?: (id: string) => void;
}

/**
 * Employee-ID-card layout for a session (#51, restyled in #53). Centered
 * avatar at the top, name and `@codename · STATUS` underneath, meta chips
 * for agent + age, then a full-width action bar at the bottom. Thematic
 * action labels (Send Off-Duty / Re-spawn / Dismiss) reinforce the
 * digital-workforce metaphor.
 */
export function SessionWorkerCard({
  session,
  showOwner = false,
  onStop,
  onDestroy,
  onRecreate,
}: SessionWorkerCardProps) {
  const { t } = useTranslation();
  const status: SessionStatus = session.status || "pending";
  const config = sessionStatusConfig[status] || sessionStatusConfig.pending;
  const slug = codename(session.id);
  const avatarSrc = avatarUrl(session.id, session.preset);

  return (
    <Card
      key={session.id}
      size="sm"
      className="overflow-visible pt-0 transition-shadow hover:shadow-md"
    >
      {/* Body — centered circular avatar (overflows the top edge by 50% for
          the ID-card-on-a-lanyard look) + identity stack. */}
      <CardContent className="flex flex-col items-center gap-2 text-center">
        <Link
          to={`/sessions/${session.id}`}
          className="-mt-8 block rounded-full ring-foreground/10 transition-shadow hover:ring-primary/40 focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:outline-none"
          aria-label={t("worker.viewAria", { name: session.name })}
        >
          <img
            src={avatarSrc}
            alt=""
            className="size-16 shrink-0 rounded-full border-2 border-card bg-muted ring-1 ring-foreground/10"
            draggable={false}
          />
        </Link>

        <div className="min-w-0 space-y-0.5">
          <h3 className="truncate text-sm font-semibold text-foreground">
            <Link to={`/sessions/${session.id}`} className="hover:underline">
              {session.name}
            </Link>
          </h3>
          <div className="flex items-center justify-center gap-1.5 text-xs">
            <span className="truncate font-mono text-muted-foreground">@{slug}</span>
            <span
              className={cn(
                "flex items-center gap-1 rounded-full px-1.5 py-px text-[0.625rem] font-semibold tracking-wider uppercase",
                config.bandClassName,
              )}
            >
              <span className="size-1.5 rounded-full bg-current" />
              {t(config.workerLabelKey)}
            </span>
          </div>
          {session.agentTitle && (
            <p className="line-clamp-2 text-xs text-muted-foreground">{session.agentTitle}</p>
          )}
        </div>

        {/* Meta chips — preset + age. */}
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <Badge variant="secondary" className="gap-1 text-[0.625rem] font-normal">
            <Bot className="size-3" />
            {session.preset}
          </Badge>
          <Badge variant="secondary" className="gap-1 text-[0.625rem] font-normal">
            <Clock className="size-3" />
            {timeAgo(session.createdAt)}
          </Badge>
          {session.hasResult && (
            <Badge
              variant="outline"
              className="gap-1 border-success/30 bg-success-bg text-[0.625rem] font-normal text-success-fg"
            >
              <span className="size-1.5 rounded-full bg-success" />
              {t("worker.result")}
            </Badge>
          )}
        </div>

        {/* Optional admin-view owner + optional git url, dense single lines. */}
        {(showOwner && session.user) || session.gitRepoUrl ? (
          <div className="flex w-full flex-col items-center gap-0.5 text-xs text-muted-foreground">
            {showOwner && session.user && (
              <span className="flex items-center gap-1">
                <User className="size-3" />
                <span className="truncate">{session.user.name || session.user.email}</span>
              </span>
            )}
            {session.gitRepoUrl && (
              <span className="flex max-w-full items-center gap-1">
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{session.gitRepoUrl}</span>
              </span>
            )}
          </div>
        ) : null}
      </CardContent>

      {/* Action bar — shadcn `CardFooter` gives us the bottom strip (border-t,
          bg-muted/50, rounded-b-xl, size-aware padding). Buttons stack their
          icon over a small label so 3 fit comfortably even on the narrowest
          card width (220px), mobile-tab-bar style. */}
      <CardFooter className="p-1">
        <Link
          to={`/sessions/${session.id}`}
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), actionButtonClass)}
        >
          <Eye className="size-4" />
          <span>{t("worker.view")}</span>
        </Link>
        {status === "running" && onStop && (
          <Button
            variant="ghost"
            size="sm"
            className={actionButtonClass}
            onClick={() => onStop(session.id, session.name)}
          >
            <Square className="size-4" />
            <span>{t("worker.sendOffDuty")}</span>
          </Button>
        )}
        {status === "stopped" && onRecreate && (
          <Button
            variant="ghost"
            size="sm"
            className={actionButtonClass}
            onClick={() => onRecreate(session.id)}
          >
            <RotateCcw className="size-4" />
            <span>{t("worker.respawn")}</span>
          </Button>
        )}
        {status === "stopped" && onDestroy && (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              actionButtonClass,
              "text-destructive hover:bg-destructive/10 hover:text-destructive",
            )}
            onClick={() => onDestroy(session.id, session.name)}
          >
            <UserX className="size-4" />
            <span>{t("worker.dismiss")}</span>
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
