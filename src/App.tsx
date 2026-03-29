import { Routes, Route, Navigate, Outlet } from "react-router";
import { useTheme } from "@/hooks/use-theme";

// Layout placeholder — will be replaced by client-agent
function AuthLayout() {
  useTheme();
  return <Outlet />;
}

export function App() {
  useTheme();
  return (
    <Routes>
      <Route path="/login" element={<div>Login (TODO)</div>} />
      <Route element={<AuthLayout />}>
        <Route path="/dashboard" element={<div>Dashboard (TODO)</div>} />
        <Route path="/sessions/:sessionId" element={<div>Session (TODO)</div>} />
        <Route path="/settings/*" element={<div>Settings (TODO)</div>} />
        <Route path="/templates/*" element={<div>Templates (TODO)</div>} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
