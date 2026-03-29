import { runMigrations } from "@/db/migrate";

declare const defineNitroPlugin: (plugin: () => Promise<void>) => unknown;

export default defineNitroPlugin(async () => {
  console.log("[blackhouse] Running database migrations...");
  await runMigrations();
  console.log("[blackhouse] Migrations complete.");
});
