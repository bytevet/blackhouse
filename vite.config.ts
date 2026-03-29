import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 3000,
    allowedHosts: ["localhost", "host.docker.internal"],
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart({ spa: {} }),
    react(),
    nitro({
      features: { websocket: true },
      serverDir: "./server",
    }),
  ],
  optimizeDeps: {
    exclude: ["ssh2", "cpu-features"],
  },
});
