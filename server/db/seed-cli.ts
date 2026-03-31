import "dotenv/config";
import { runSeed } from "./seed.js";

runSeed()
  .then(() => {
    console.log("[blackhouse] Seed completed successfully.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[blackhouse] Seed failed:", err);
    process.exit(1);
  });
