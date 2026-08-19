import { useCallback, useMemo, useState } from "react";
import { Outlet, useMatch, useNavigate, useParams } from "react-router";
import { ChannelSidebar } from "@/components/channel/channel-sidebar";
import { ChannelStyles } from "@/components/channel/channel-styles";
import { normaliseRepoUrl } from "@/components/channel/channel-api";
import { CreateChannelDialog } from "@/components/channel/create-channel-dialog";
import { useMediaQuery } from "@/components/channel/use-media-query";
import type { UserView } from "@/components/channel/types";
import { WorkspaceProvider, useWorkspace } from "@/components/workspace/workspace-context";
import { useSidebarCollapsed } from "@/components/workspace/use-sidebar-collapsed";
import { useSession } from "@/lib/auth-client";

/**
 * The one shell every room renders inside.
 *
 * Channels and agents used to be separate full-viewport screens, each with its
 * own sidebar — so opening an agent cost you the channel list, the roster and
 * the transcript you were reading, and getting back meant a breadcrumb. Agents
 * are meant to read as teammates in a workspace, and the workspace vanished the
 * moment you looked at one.
 *
 * Now the rail is permanent and only the centre swaps. The prototype models
 * that as `view: 'channel' | 'agent'` state; here it is a layout route with an
 * `<Outlet />`, which gets the same result while keeping every room a real URL —
 * deep links, the back button, and an agent you can paste to a colleague.
 */

/** Header of the rail. The instance has no workspace record to read from yet. */
const WORKSPACE = { name: "Blackhouse", tagline: "blackhouse · self-hosted" };

export function AppShell() {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  );
}

function Shell() {
  const navigate = useNavigate();
  const narrow = useMediaQuery("(max-width: 900px)");
  const { data: session } = useSession();
  const workspace = useWorkspace();

  const { slug } = useParams();
  const agentMatch = useMatch("/agents/:agentId");
  // `new` is the create dialog, not an agent — it must not light up a rail row.
  const activeAgentId =
    agentMatch?.params.agentId && agentMatch.params.agentId !== "new"
      ? agentMatch.params.agentId
      : null;

  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const currentUser = useMemo<UserView | null>(
    () =>
      session?.user
        ? { id: session.user.id, name: session.user.name, role: session.user.role ?? null }
        : null,
    [session?.user],
  );

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const sidebar = (
    <ChannelSidebar
      workspace={WORKSPACE}
      channels={workspace.channels}
      activeSlug={slug ?? null}
      agents={workspace.agents}
      activeAgentId={activeAgentId}
      currentUser={currentUser ?? { id: "unknown", name: "Signed out" }}
      channelsLoading={workspace.channelsLoading}
      channelsError={workspace.channelsError}
      agentsLoading={workspace.agentsLoading}
      agentsError={workspace.agentsError}
      // The rail collapses only where there is room for the distinction to
      // matter. On a phone it is already a drawer, and a 60px strip over the
      // transcript would be a third state with no benefit.
      collapsed={!narrow && collapsed}
      onToggleCollapsed={narrow ? undefined : () => setCollapsed((c) => !c)}
      onCreateChannel={() => {
        setDrawerOpen(false);
        setCreateOpen(true);
      }}
      onNavigate={narrow ? closeDrawer : undefined}
      onClose={narrow ? closeDrawer : undefined}
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

      {/* Wide: a permanent rail. Narrow: a drawer over the content, because the
          content is the part that has to survive a phone. */}
      {!narrow && sidebar}
      {narrow && drawerOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex" }}>
          <div style={{ height: "100%" }}>{sidebar}</div>
          <button
            type="button"
            aria-label="Close channels"
            onClick={closeDrawer}
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
        <Outlet context={{ onOpenSidebar: narrow ? () => setDrawerOpen(true) : undefined }} />
      </main>

      <CreateChannelDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={async ({ slug: newSlug, repo, branch, isPrivate }) => {
          const gitRepoUrl = normaliseRepoUrl(repo);
          const created = await workspace.createChannel({
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

/** What the shell hands its rooms through the outlet. */
export interface ShellContext {
  /** Present only on narrow viewports, where the rail is a drawer. */
  onOpenSidebar?: () => void;
}
