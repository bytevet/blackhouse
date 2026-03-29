/// <reference types="vite/client" />
import type { ReactNode } from "react";
import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import appCss from "@/index.css?url";
import { DefaultErrorComponent } from "@/components/default-error";
import { NotFound } from "@/components/not-found";
import { getServerSession } from "@/lib/auth-server";
import { useTheme } from "@/hooks/use-theme";

export const Route = createRootRoute({
  beforeLoad: async () => {
    const user = await getServerSession();
    return { user };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Blackhouse" },
    ],
    links: [
      { rel: "icon", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  errorComponent: (props) => (
    <RootDocument>
      <DefaultErrorComponent {...props} />
    </RootDocument>
  ),
  notFoundComponent: () => (
    <RootDocument>
      <NotFound />
    </RootDocument>
  ),
  component: RootComponent,
});

function RootComponent() {
  useTheme();
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("blackhouse-theme");if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches))document.documentElement.classList.add("dark")}catch(e){}})()`,
          }}
        />
        {children}
        <Scripts />
      </body>
    </html>
  );
}
