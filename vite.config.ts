import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    react(),
    nitro({
      features: { websocket: true },
      serverDir: "./server",
    }),
  ],
  ssr: {
    external: ["better-auth", "dockerode", "ssh2", "cpu-features"],
  },
  optimizeDeps: {
    exclude: ["ssh2", "cpu-features"],
  },
});
