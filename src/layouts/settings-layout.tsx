import { Outlet } from "react-router";

/**
 * Settings section layout — sub-nav (Profile/Agents/Docker/Users) lives in
 * the sidebar now, so this is just a padded scroll container around the
 * active page.
 */
export function SettingsLayout() {
  return (
    <div className="flex flex-1 flex-col overflow-auto p-4 md:p-6">
      <Outlet />
    </div>
  );
}
