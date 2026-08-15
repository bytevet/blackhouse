import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { CircleAlert } from "lucide-react";
import { Button } from "@notyet.im/ui";
import { ChannelHeader } from "@/components/channel/channel-header";
import { ChannelSidebar } from "@/components/channel/channel-sidebar";
import { ChannelStyles } from "@/components/channel/channel-styles";
import { normaliseRepoUrl } from "@/components/channel/channel-api";
import { Composer } from "@/components/channel/composer";
import { CreateChannelDialog } from "@/components/channel/create-channel-dialog";
import { Transcript } from "@/components/channel/transcript";
import type { DeliveryMode, UserView } from "@/components/channel/types";
import { useChannelData } from "@/components/channel/use-channel-data";
import { useMediaQuery } from "@/components/channel/use-media-query";
import { useSession } from "@/lib/auth-client";

/**
 * The Channel View — the primary screen.
 *
 * Three regions: the rail (channels + agent roster), the transcript, and the
 * composer. This file is a layout and nothing else: it owns the draft, the
 * delivery mode and two dialogs. Every byte of server data — the roster, the
 * transcript, the live stream, the writes — comes from `useChannelData`, and
 * the components below it stay pure and presentational.
 */

/** Header of the rail. The instance has no workspace record to read from yet. */
const WORKSPACE = { name: "Blackhouse", tagline: "blackhouse · self-hosted" };

export function ChannelPage() {
  const { slug = "general" } = useParams();
  const navigate = useNavigate();
  const narrow = useMediaQuery("(max-width: 900px)");
  const { data: session } = useSession();

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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const knownHandles = useMemo(() => data.agents.map((a) => a.handle), [data.agents]);

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

  const sidebar = (
    <ChannelSidebar
      workspace={WORKSPACE}
      channels={data.channels}
      activeSlug={slug}
      agents={data.agents}
      currentUser={currentUser ?? { id: "unknown", name: "Signed out" }}
      channelsLoading={data.channelsLoading}
      channelsError={data.channelsError}
      agentsLoading={data.agentsLoading}
      agentsError={data.agentsError}
      onCreateChannel={() => {
        setDrawerOpen(false);
        setCreateOpen(true);
      }}
      onClose={narrow ? () => setDrawerOpen(false) : undefined}
    />
  );

  return (
    <div
      style={{
        height: "100dvh",
        width: "100%",
        display: "flex",
        background: "var(--ny-bg)",
        color: "var(--ny-text)",
        fontFamily: "var(--ny-font-sans)",
        fontSize: 14,
        overflow: "hidden",
      }}
    >
      <ChannelStyles />

      {/* Wide: a permanent rail. Narrow: a drawer over the transcript, because
          the transcript is the part that has to survive a phone. */}
      {!narrow && sidebar}
      {narrow && drawerOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex" }}>
          <div style={{ height: "100%" }}>{sidebar}</div>
          <button
            type="button"
            aria-label="Close channels"
            onClick={() => setDrawerOpen(false)}
            className="bh-reset"
            style={{ flex: 1, background: "var(--ny-overlay, rgba(0,0,0,.5))", cursor: "pointer" }}
          />
        </div>
      )}

      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
          background: "var(--ny-bg)",
        }}
      >
        {channel ? (
          <>
            <ChannelHeader
              channel={channel}
              onToggleAutoApprove={(next) => void data.setAutoApprove(next)}
              onOpenSidebar={narrow ? () => setDrawerOpen(true) : undefined}
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
              agents={data.agents}
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
            onOpenSidebar={narrow ? () => setDrawerOpen(true) : undefined}
          />
        )}
      </main>

      <CreateChannelDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={async ({ slug: newSlug, repo, branch, isPrivate }) => {
          const gitRepoUrl = normaliseRepoUrl(repo);
          const created = await data.createChannel({
            slug: newSlug,
            gitRepoUrl,
            gitBranch: gitRepoUrl ? branch || "main" : null,
            isPrivate,
          });
          setCreateOpen(false);
          if (created) navigate(`/channels/${created.slug}`);
        }}
      />
    </div>
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
