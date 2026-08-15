import { Routes, Route, Navigate } from "react-router";
import { AuthLayout } from "@/layouts/auth-layout";
import { SettingsLayout } from "@/layouts/settings-layout";
import { LoginPage } from "@/pages/login";
import { ChannelPage } from "@/pages/channel";
import { AgentsPage } from "@/pages/agents";
import { AgentPage } from "@/pages/agent";
import { CreateAgentPage } from "@/pages/create-agent";
import { ProfilePage } from "@/pages/settings/profile";
import { BlueprintsPage } from "@/pages/settings/blueprints";
import { RuntimesPage } from "@/pages/settings/runtimes";
import { EgressPage } from "@/pages/settings/egress";
import { MembersPage } from "@/pages/settings/members";

/**
 * Channel and agent pages own their full viewport — the design gives each its
 * own sidebar and header rather than sharing one app shell — so they are not
 * wrapped in a chrome layout. Only settings keeps a nested layout.
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AuthLayout />}>
        <Route path="/channels" element={<Navigate to="/channels/general" replace />} />
        <Route path="/channels/:slug" element={<ChannelPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/new" element={<CreateAgentPage />} />
        <Route path="/agents/:agentId" element={<AgentPage />} />
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
  );
}
