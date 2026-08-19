import { Routes, Route, Navigate, useLocation, type Location } from "react-router";
import { AppShell } from "@/layouts/app-shell";
import { AuthLayout } from "@/layouts/auth-layout";
import { SettingsLayout } from "@/layouts/settings-layout";
import { LoginPage } from "@/pages/login";
import { ChannelPage } from "@/pages/channel";
import { AgentPane } from "@/pages/agent-pane";
import { CreateAgentPage } from "@/pages/create-agent";
import { ProfilePage } from "@/pages/settings/profile";
import { BlueprintsPage } from "@/pages/settings/blueprints";
import { RuntimesPage } from "@/pages/settings/runtimes";
import { EgressPage } from "@/pages/settings/egress";
import { MembersPage } from "@/pages/settings/members";

/**
 * Channels and agents are rooms inside one shell, not screens beside each
 * other. `AppShell` owns the rail, the workspace data and the single SSE
 * connection; only the content area changes as you move between them, so
 * opening an agent no longer costs you the channel list and the roster.
 *
 * They stay real routes rather than a `view` flag because that is what keeps
 * every room addressable — deep links, the back button, and an agent you can
 * paste to someone. Settings keeps its own layout: it is a different mode, not
 * another room.
 */

/** State a link attaches so a modal route knows what to leave on screen behind it. */
export interface ModalRouteState {
  backgroundLocation?: Location;
}

export function App() {
  const location = useLocation();
  const creatingAgent = location.pathname === "/agents/new";

  /**
   * `/agents/new` is a dialog over a room, not a room of its own.
   *
   * A modal needs something behind it, and it used to have the roster screen.
   * With the roster folded into the rail there is nothing left to nest under,
   * so the route renders against a *background location* — the standard React
   * Router idiom — and the room you came from stays mounted and visible.
   *
   * The `?? "/channels"` is the direct-load case: paste the URL into a fresh
   * tab and there is no history to fall back on, so it opens over the default
   * channel rather than over a blank content area.
   */
  const background = creatingAgent
    ? ((location.state as ModalRouteState | null)?.backgroundLocation ?? {
        ...location,
        pathname: "/channels",
        state: null,
      })
    : null;

  return (
    <>
      <Routes location={background ?? location}>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AuthLayout />}>
          <Route element={<AppShell />}>
            <Route path="/channels" element={<Navigate to="/channels/general" replace />} />
            <Route path="/channels/:slug" element={<ChannelPage />} />
            {/* The roster screen is gone — the rail is the roster. `/agents`
                keeps working for anyone who bookmarked it. */}
            <Route path="/agents" element={<Navigate to="/channels" replace />} />
            <Route path="/agents/:agentId" element={<AgentPane />} />
          </Route>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="/settings/blueprints" replace />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="blueprints" element={<BlueprintsPage />} />
            <Route path="runtimes" element={<RuntimesPage />} />
            <Route path="egress" element={<EgressPage />} />
            <Route path="members" element={<MembersPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/channels" replace />} />
      </Routes>

      {creatingAgent && (
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/agents/new" element={<CreateAgentPage />} />
          </Route>
        </Routes>
      )}
    </>
  );
}
