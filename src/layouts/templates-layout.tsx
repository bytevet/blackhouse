import { Outlet } from "react-router";

/**
 * Templates section layout — sub-nav (My/Public Templates) lives in the
 * sidebar now, so this is just a padded scroll container around the active
 * page.
 */
export function TemplatesLayout() {
  return (
    <div className="flex flex-1 flex-col overflow-auto p-4 md:p-6">
      <Outlet />
    </div>
  );
}
