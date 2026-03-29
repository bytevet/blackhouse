import { Routes, Route, Navigate } from "react-router";
import { useTheme } from "@/hooks/use-theme";
import { AuthLayout } from "@/layouts/auth-layout";
import { SettingsLayout } from "@/layouts/settings-layout";
import { TemplatesLayout } from "@/layouts/templates-layout";
import { LoginPage } from "@/pages/login";
import { DashboardPage } from "@/pages/dashboard";
import { SessionPage } from "@/pages/session";
import { ProfilePage } from "@/pages/settings/profile";
import { AgentsPage } from "@/pages/settings/agents";
import { DockerPage } from "@/pages/settings/docker";
import { UsersPage } from "@/pages/settings/users";
import { MyTemplatesPage } from "@/pages/templates/mine";
import { PublicTemplatesPage } from "@/pages/templates/public";

export function App() {
  useTheme();
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AuthLayout />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/sessions/:sessionId" element={<SessionPage />} />
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="/settings/profile" replace />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="docker" element={<DockerPage />} />
          <Route path="users" element={<UsersPage />} />
        </Route>
        <Route path="/templates" element={<TemplatesLayout />}>
          <Route index element={<Navigate to="/templates/mine" replace />} />
          <Route path="mine" element={<MyTemplatesPage />} />
          <Route path="public" element={<PublicTemplatesPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
