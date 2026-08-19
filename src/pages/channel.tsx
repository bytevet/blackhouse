import { useCallback, useMemo, useState } from "react";
import { useOutletContext, useParams } from "react-router";
import { CircleAlert } from "lucide-react";
import { Button } from "@notyet.im/ui";
import { ChannelHeader } from "@/components/channel/channel-header";
import { Composer } from "@/components/channel/composer";
import { Transcript } from "@/components/channel/transcript";
import type { DeliveryMode, UserView } from "@/components/channel/types";
import { useChannelData } from "@/components/channel/use-channel-data";
import { useWorkspace } from "@/components/workspace/workspace-context";
import type { ShellContext } from "@/layouts/app-shell";
import { useSession } from "@/lib/auth-client";

/**
 * One channel: header, transcript, composer.
 *
 * The rail, the workspace data and the create-channel dialog moved to
 * `AppShell` — this renders inside it now, so that an agent opening in the same
 * content area does not take the channel list and roster down with it. What is
 * left is a layout over `useChannelData`: the draft and the delivery mode, and
 * nothing else.
 */

export function ChannelPage() {
  const { slug = "general" } = useParams();
  const { onOpenSidebar } = useOutletContext<ShellContext>() ?? {};
  const { data: session } = useSession();
  const workspace = useWorkspace();

  const currentUser = useMemo<UserView | null>(
    () =>
      session?.user
        ? { id: session.user.id, name: session.user.name, role: session.user.role ?? null }
        : null,
    [session?.user],
  );

  const data = useChannelData(slug, currentUser);
  const { channel } = data;

  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<DeliveryMode>("queue");

  const knownHandles = useMemo(() => workspace.agents.map((a) => a.handle), [workspace.agents]);

  /**
   * Posting is optimistic, and the *outcome* is the server's.
   *
   * The draft is cleared only once the post is accepted: a failed send that
   * silently ate what you typed is worse than one that leaves it in the box for
   * you to retry. Whether the run was queued — and why — comes back on the
   * response and is rendered as the chip under the message; the client no
   * longer guesses from the roster's `activity`.
   */
  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    if (await data.send(body, mode)) setDraft("");
  }, [data, draft, mode]);

  return (
    <>
      {channel ? (
        <>
          <ChannelHeader
            channel={channel}
            live={workspace.live}
            onToggleAutoApprove={(next) => void data.setAutoApprove(next)}
            onOpenSidebar={onOpenSidebar}
          />

          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            <Transcript
              entries={data.entries}
              knownHandles={knownHandles}
              loading={data.transcriptLoading}
              error={data.transcriptError}
              onRetry={data.reloadTranscript}
              hasMore={data.hasMore}
              loadingMore={data.loadingMore}
              onLoadOlder={data.loadOlder}
              onApproveDispatch={(id, prompt) => void data.approveDispatch(id, prompt)}
              onDenyDispatch={(id) => void data.denyDispatch(id)}
            />
          </div>

          {data.actionError && (
            <ActionError message={data.actionError} onDismiss={data.clearActionError} />
          )}

          <Composer
            channelSlug={channel.slug}
            agents={workspace.agents}
            value={draft}
            onChange={setDraft}
            mode={mode}
            onModeChange={setMode}
            onSend={() => void send()}
          />
        </>
      ) : (
        <MissingChannel
          slug={slug}
          loading={data.channelLoading}
          error={data.channelError}
          onRetry={data.reload}
          onOpenSidebar={onOpenSidebar}
        />
      )}
    </>
  );
}

/**
 * A write that failed, said out loud above the composer.
 *
 * Posting, approving and toggling auto-approve all land here. A silent failure
 * on any of the three would leave the screen looking like the action worked.
 */
function ActionError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 9,
        margin: "0 clamp(10px, 3vw, 26px)",
        padding: "9px 12px",
        borderRadius: 10,
        border: "1px solid var(--ny-danger-border)",
        background: "var(--ny-danger-subtle)",
        fontSize: 12.5,
        color: "var(--ny-danger-text)",
      }}
    >
      <CircleAlert size={15} strokeWidth={2} style={{ flex: "none" }} />
      <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{message}</span>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

/** No channel to show — either still loading, failed to load, or genuinely absent. */
function MissingChannel({
  slug,
  loading,
  error,
  onRetry,
  onOpenSidebar,
}: {
  slug: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpenSidebar?: () => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        placeItems: "center",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 420 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>
          {loading
            ? "Loading channel…"
            : error
              ? "Could not open this channel"
              : `#${slug} not found`}
        </div>
        <div
          style={{
            marginTop: 6,
            fontSize: 12.5,
            color: "var(--ny-text-subtle)",
            fontFamily: "var(--ny-font-mono)",
            overflowWrap: "anywhere",
          }}
        >
          {error ?? (loading ? "" : "It may have been archived, or the name may be misspelled.")}
        </div>
        {!loading && (
          <div style={{ marginTop: 14, display: "flex", gap: 8, justifyContent: "center" }}>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
            {onOpenSidebar && (
              <Button variant="ghost" size="sm" onClick={onOpenSidebar}>
                Browse channels
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
